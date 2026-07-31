/**
 * P3.4 (2026-07-30) — auto-alerts at confirmed completion levels.
 *
 * These assertions guard a switch that touches the owner's LIVE account. An alert
 * is the only thing this toolchain creates that it cannot take back: `draw_clear`,
 * `removeOrphans` and the drawing registry are drawing machinery and know nothing
 * about alerts, so a wrong one stays until a human deletes it by id.
 *
 * Which is why almost everything here is a CALL rather than a regex. The P2.4
 * review found a neutered condition (`if (false && ...)`) passing every source-text
 * contract while the gate it guarded was dead — a source contract pins that a rule
 * exists, only a call pins what it does. The two source contracts that remain are
 * the ones a call cannot express: a DEFAULT VALUE in a signature, and the absence
 * of a flag from two scheduled scripts.
 *
 * Run: node --test tests/alert_plan.test.js
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ALERT_PREFIX, ALERT_DEFAULTS,
  alertPlan, alertMessage, isMcpAlert, existingAlertPrice, autoAlerts,
} from '../src/core/alert_plan.js';

const src = (f) => readFileSync(`${process.cwd()}/${f}`, 'utf8');

// ── fixtures ────────────────────────────────────────────────────────────────

const SPOT = 100;

/** A confirmed bullish pattern whose completion level is above spot. */
const bull = (over = {}) => ({
  pattern: 'bull_flag', status: 'confirmed', direction: 'bullish',
  completion_level: 104, bars_ago: 0, ...over,
});
/** A confirmed bearish pattern whose completion level is below spot. */
const bear = (over = {}) => ({
  pattern: 'head_and_shoulders', status: 'confirmed', direction: 'bearish',
  completion_level: 96, bars_ago: 2, ...over,
});

const plan = (patterns, opts = {}, existing = []) =>
  alertPlan(patterns, SPOT, existing, { symbol: 'BATS:GRMN', ...opts });

/** Records every call, so "was it even asked" is answerable. */
function fakes({ alerts = [], createResult = { success: true, alert_id: 7 }, createThrows = null, listThrows = null } = {}) {
  const calls = { list: 0, created: [] };
  return {
    calls,
    io: {
      list: async () => { calls.list += 1; if (listThrows) throw new Error(listThrows); return { alerts }; },
      create: async (args) => {
        calls.created.push(args);
        if (createThrows) throw new Error(createThrows);
        return typeof createResult === 'function' ? createResult(args, calls.created.length) : createResult;
      },
    },
  };
}

// ── the planner ─────────────────────────────────────────────────────────────

describe('alertPlan — what earns a real alert', () => {
  test('a confirmed, fresh, correctly-placed pattern is planned, with everything the create needs', () => {
    const p = plan([bull()]);
    assert.equal(p.create.length, 1);
    assert.deepEqual(p.skipped, []);
    const c = p.create[0];
    assert.equal(c.symbol, 'BATS:GRMN');
    assert.equal(c.price, 104);
    assert.equal(c.condition, 'crossing_up', 'directional, not a plain cross that fires either way');
    assert.equal(c.pattern, 'bull_flag');
    assert.equal(c.spot, SPOT);
    assert.equal(c.distance_pct, 4);
    assert.ok(c.message.startsWith(ALERT_PREFIX), 'the prefix IS the cleanup story — without it the alert '
      + 'cannot be told from one the owner set by hand');
  });

  test('a bearish break gets a DOWNWARD cross', () => {
    assert.equal(plan([bear()]).create[0].condition, 'crossing_down');
  });

  test('FORMING is refused — an alert on a hypothesis is a hypothesis with a notification', () => {
    const p = plan([bull({ status: 'forming' })]);
    assert.equal(p.create.length, 0);
    assert.match(p.skipped[0].why, /not confirmed/);
  });

  test('STALE is refused, both ways it can be expressed', () => {
    // patternAgePlan's own output shape.
    const flagged = plan([bull({ stale: true, bars_ago: 45 })], { max_age_bars: 21 });
    assert.equal(flagged.create.length, 0);
    assert.match(flagged.skipped[0].why, /age-excluded/);

    // And re-checked from bars_ago rather than trusted: the caller passing a stale
    // pattern must not be able to create a live alert on a shape 45 bars old.
    const byAge = plan([bull({ bars_ago: 45 })], { max_age_bars: 21 });
    assert.equal(byAge.create.length, 0);
    assert.match(byAge.skipped[0].why, /45 bars ago, max 21/);

    // Inside the window it survives.
    assert.equal(plan([bull({ bars_ago: 20 })], { max_age_bars: 21 }).create.length, 1);
  });

  test('an unmeasurable age is NOT stale — unknown is not evidence', () => {
    assert.equal(plan([bull({ bars_ago: null })], { max_age_bars: 21 }).create.length, 1);
  });

  test('the VERDICT SIDE only, and a pattern with no direction is refused outright', () => {
    const off = plan([bear()], { bias: 'BULLISH' });
    assert.equal(off.create.length, 0);
    assert.match(off.skipped[0].why, /contradicts the BULLISH verdict/);

    assert.equal(plan([bull()], { bias: 'BULLISH' }).create.length, 1);
    // No bias filters nothing — the same rule planPatternDrawings follows.
    assert.equal(plan([bull(), bear()]).create.length, 2);

    const none = plan([bull({ direction: null })]);
    assert.equal(none.create.length, 0);
    assert.match(none.skipped[0].why, /which side of spot/,
      'direction decides which side is correct, so without it there is no correct alert');
  });

  test('THE SIDE OF SPOT — a level already broken never becomes an alert', () => {
    // A bullish completion BELOW spot has already happened. An alert there fires
    // the instant it is created and reports nothing.
    const through = plan([bull({ completion_level: 96 })]);
    assert.equal(through.create.length, 0);
    assert.equal(through.skipped[0].already_through, true);
    assert.match(through.skipped[0].why, /below spot 100/);

    const bearThrough = plan([bear({ completion_level: 104 })]);
    assert.equal(bearThrough.create.length, 0);
    assert.equal(bearThrough.skipped[0].already_through, true);

    // Exactly AT spot is not a trigger, it is now.
    const at = plan([bull({ completion_level: SPOT })]);
    assert.equal(at.create.length, 0);
    assert.match(at.skipped[0].why, /is AT spot/);
  });

  test('no completion level means no price to alert at', () => {
    for (const bad of [null, undefined, NaN]) {
      const p = plan([bull({ completion_level: bad })]);
      assert.equal(p.create.length, 0);
      assert.match(p.skipped[0].why, /no completion level/);
    }
  });

  test('DEDUPE — a re-run must not stack a second alert on the same level', () => {
    const existing = [{ alert_id: 11, symbol: 'BATS:GRMN', message: `${ALERT_PREFIX} GRMN bull_flag confirmed completes @ 104 - auto-alert` }];
    const p = plan([bull()], { tolerance_pct: 0.4 }, existing);
    assert.equal(p.create.length, 0);
    assert.equal(p.skipped[0].duplicate_of, 11);
    assert.match(p.skipped[0].why, /already exists at 104/);
    assert.equal(p.existing.mcp, 1, 'and it must be recognised as one of ours');
  });

  test('dedupe uses the TOLERANCE it was given — the drawer passes the ATR-scaled one', () => {
    const existing = [{ alert_id: 12, symbol: 'GRMN', price: 104.3 }];
    // 104.3 vs 104 is 0.29% apart: inside the old fixed rule, outside a quiet
    // chart's ATR-scaled one. The planner must not have its own opinion.
    assert.equal(plan([bull()], { tolerance_pct: 0.4 }, existing).create.length, 0);
    assert.equal(plan([bull()], { tolerance_pct: 0.16 }, existing).create.length, 1);
  });

  test('an alert on a DIFFERENT symbol is not a duplicate', () => {
    const existing = [{ alert_id: 13, symbol: 'NASDAQ:AAPL', price: 104 }];
    const p = plan([bull()], {}, existing);
    assert.equal(p.create.length, 1);
    assert.equal(p.existing.considered, 1);
    assert.equal(p.existing.on_symbol, 0);
  });

  test('an existing alert whose price cannot be read is REPORTED, and does not veto', () => {
    /**
     * The dedupe is blind to it, so a duplicate against it is possible and the
     * reader should know. It must not block, though: one hand-set alert with an
     * unreadable condition would otherwise veto every auto-alert on that name
     * forever.
     */
    const existing = [{ alert_id: 14, symbol: 'GRMN', message: 'my own alert' }];
    const p = plan([bull()], {}, existing);
    assert.equal(p.create.length, 1);
    assert.equal(p.existing.unreadable, 1);
    assert.equal(p.existing.mcp, 0);
  });

  test('THE CAP holds at three, and the overflow says why', () => {
    const four = [
      bull({ pattern: 'a', completion_level: 101 }),
      bull({ pattern: 'b', completion_level: 102 }),
      bull({ pattern: 'c', completion_level: 103 }),
      bull({ pattern: 'd', completion_level: 105 }),
    ];
    const p = plan(four);
    assert.equal(p.create.length, ALERT_DEFAULTS.max_per_run);
    assert.equal(p.create.length, 3);
    assert.deepEqual(p.create.map((c) => c.pattern), ['a', 'b', 'c'],
      'input order is the DRAWER\'s ranking — the cap must not invent a second one');
    assert.equal(p.skipped.length, 1);
    assert.match(p.skipped[0].why, /per-run cap of 3/);
    assert.equal(p.skipped[0].pattern, 'd');
  });

  test('NO SYMBOL refuses everything — alerts.create would use whatever the chart shows', () => {
    /**
     * The chart is a shared resource another script moves mid-analysis; this repo
     * has vcp_check returning three other companies' numbers during one live run.
     * An alert created against "the current symbol" is a real notification about a
     * stock nobody analysed.
     */
    const p = alertPlan([bull()], SPOT, [], { symbol: null });
    assert.equal(p.create.length, 0);
    assert.equal(p.refused, 'no symbol');
    assert.match(p.skipped[0].why, /shared resource/);
  });

  test('NO SPOT refuses everything — the side check is the whole safety story', () => {
    for (const bad of [null, undefined, 0, NaN, 'x']) {
      const p = alertPlan([bull()], bad, [], { symbol: 'GRMN' });
      assert.equal(p.create.length, 0, `spot=${bad} must refuse`);
      assert.equal(p.refused, 'no spot price');
    }
  });

  test('nothing is ever silently dropped — every input appears in create or skipped', () => {
    const patterns = [
      bull(), bear(), bull({ status: 'forming' }), bull({ completion_level: 96 }),
      bull({ pattern: 'z', direction: null }),
    ];
    const p = plan(patterns);
    assert.equal(p.create.length + p.skipped.length, patterns.length);
    for (const s of p.skipped) assert.ok(s.why, 'a refusal with no reason is a silent one');
  });

  test('the message carries the pattern, the verb and a machine-readable price', () => {
    const up = alertMessage({ symbol: 'BATS:GRMN', pattern: 'bull_flag', status: 'confirmed', direction: 'bullish', price: 104 });
    assert.equal(up, `${ALERT_PREFIX} GRMN bull_flag confirmed completes @ 104 - auto-alert`);
    const down = alertMessage({ symbol: 'GRMN', pattern: 'head_and_shoulders', status: 'confirmed', direction: 'bearish', price: 96 });
    assert.match(down, /breaks @ 96/, 'the drawings say "breaks at" for bearish — the alert must not invert it');
    assert.equal(isMcpAlert(up), true);
    assert.equal(isMcpAlert('AAPL crossing 200'), false);
    assert.equal(isMcpAlert(null), false);
  });
});

describe('existingAlertPrice — reading a level back off an alert', () => {
  test('a normalised price wins', () => {
    assert.equal(existingAlertPrice({ price: 104.5 }), 104.5);
  });
  test('then the condition series, which is the API\'s own shape', () => {
    assert.equal(existingAlertPrice({ condition: { series: [{ type: 'barset' }, { type: 'value', value: 96.25 }] } }), 96.25);
  });
  test('then our own message, which is why the format is machine-readable', () => {
    assert.equal(existingAlertPrice({ message: `${ALERT_PREFIX} GRMN bull_flag confirmed completes @ 104.75 - auto-alert` }), 104.75);
  });
  test('and null when it genuinely cannot be read — unknown, not zero', () => {
    assert.equal(existingAlertPrice({ message: 'watch this one' }), null);
    assert.equal(existingAlertPrice({}), null);
    assert.equal(existingAlertPrice(null), null);
  });
});

// ── the execution wrapper ───────────────────────────────────────────────────

describe('autoAlerts — the wrapper that touches the account', () => {
  test('DEFAULT OFF, and off means the account is not even READ', async () => {
    const f = fakes();
    const r = await autoAlerts({ patterns: [bull()], spot: SPOT, symbol: 'GRMN' }, f.io);
    assert.equal(r.enabled, false);
    assert.deepEqual(r.created, []);
    assert.equal(f.calls.list, 0, 'listing is a network call the off switch must also prevent');
    assert.equal(f.calls.created.length, 0);
    assert.match(r.note, /OFF/);
  });

  test('explicitly disabled is the same as omitted', async () => {
    const f = fakes();
    const r = await autoAlerts({ enabled: false, patterns: [bull()], spot: SPOT, symbol: 'GRMN' }, f.io);
    assert.equal(r.enabled, false);
    assert.equal(f.calls.created.length, 0);
  });

  test('enabled: it creates exactly what the planner planned, and nothing else', async () => {
    const f = fakes({ createResult: (args, n) => ({ success: true, alert_id: 100 + n }) });
    const r = await autoAlerts({
      enabled: true,
      patterns: [bull(), bear(), bull({ pattern: 'forming_one', status: 'forming' })],
      spot: SPOT, symbol: 'BATS:GRMN',
    }, f.io);

    assert.equal(f.calls.list, 1);
    assert.equal(f.calls.created.length, 2, 'the forming pattern must never reach the account');
    assert.deepEqual(f.calls.created.map((c) => c.price), [104, 96]);
    assert.deepEqual(f.calls.created.map((c) => c.condition), ['crossing_up', 'crossing_down']);
    for (const c of f.calls.created) assert.ok(c.message.startsWith(ALERT_PREFIX));
    assert.deepEqual(r.created.map((c) => c.alert_id), [101, 102]);
    assert.equal(r.failed.length, 0);
    assert.equal(r.skipped.length, 1);
    assert.match(r.note, /alert_delete/, 'the report must carry the cleanup path, since there is no sweep');
  });

  test('the bias reaches the planner — a BEARISH verdict creates no bullish alert', async () => {
    const f = fakes();
    await autoAlerts({ enabled: true, patterns: [bull()], spot: SPOT, symbol: 'GRMN', bias: 'BEARISH' }, f.io);
    assert.equal(f.calls.created.length, 0);
  });

  test('the existing list reaches the dedupe — a re-run creates nothing twice', async () => {
    const f = fakes({ alerts: [{ alert_id: 9, symbol: 'GRMN', price: 104 }] });
    const r = await autoAlerts({ enabled: true, patterns: [bull()], spot: SPOT, symbol: 'GRMN' }, f.io);
    assert.equal(f.calls.created.length, 0);
    assert.equal(r.created.length, 0);
    assert.equal(r.skipped[0].duplicate_of, 9);
  });

  test('a FAILED list refuses the whole run — no dedupe means no creating', async () => {
    /**
     * Unknown is not safe here. Without the existing alerts every re-run stacks
     * another permanent alert, and there is nothing that removes them.
     */
    const f = fakes({ listThrows: 'CDP disconnected' });
    const r = await autoAlerts({ enabled: true, patterns: [bull()], spot: SPOT, symbol: 'GRMN' }, f.io);
    assert.equal(f.calls.created.length, 0);
    assert.equal(r.refused, 'alert_list unavailable');
    assert.match(r.skipped[0].why, /stack another permanent alert/);
  });

  test('an error INSIDE the list payload is a failure too, not an empty account', async () => {
    // `alerts.list` returns { alerts: [], error } rather than throwing. Reading that
    // as "no alerts exist" would turn a broken read into a licence to duplicate.
    const f = fakes();
    f.io.list = async () => ({ alerts: [], error: 'Unexpected response' });
    const r = await autoAlerts({ enabled: true, patterns: [bull()], spot: SPOT, symbol: 'GRMN' }, f.io);
    assert.equal(r.refused, 'alert_list unavailable');
    assert.equal(f.calls.created.length, 0);
  });

  test('a create with NO alert_id is a FAILURE, whatever success says', async () => {
    /**
     * Same shape as drawShape returning success with a null entity id, and as
     * manageIndicator returning success:false without throwing. An alert nobody can
     * identify is an alert nobody can delete.
     */
    const f = fakes({ createResult: { success: true, alert_id: null } });
    const r = await autoAlerts({ enabled: true, patterns: [bull()], spot: SPOT, symbol: 'GRMN' }, f.io);
    assert.equal(r.created.length, 0);
    assert.equal(r.failed.length, 1);
    assert.match(r.failed[0].error, /no alert_id/);
  });

  test('one create throwing does not lose the others, and is reported', async () => {
    let n = 0;
    const calls = [];
    const io = {
      list: async () => ({ alerts: [] }),
      create: async (args) => {
        calls.push(args); n += 1;
        if (n === 1) throw new Error('rejected by TradingView: internal');
        return { success: true, alert_id: 55 };
      },
    };
    const r = await autoAlerts({ enabled: true, patterns: [bull(), bear()], spot: SPOT, symbol: 'GRMN' }, io);
    assert.equal(calls.length, 2, 'the second create must still be attempted');
    assert.equal(r.failed.length, 1);
    assert.equal(r.created.length, 1);
    assert.match(r.failed[0].error, /rejected by TradingView/);
  });
});

// ── the two contracts a call cannot express ─────────────────────────────────

describe('default OFF at every layer, and unreachable from an unattended run', () => {
  test('the scheduled scripts do not mention it — an opt-in a batch can set is not opt-in', () => {
    /**
     * The one contract that has to be source text: it is about what is ABSENT.
     * A 05:30 batch over twenty machine-selected charts would put sixty permanent
     * alerts on the account with nobody present to be asked.
     */
    for (const f of ['scripts/morning-screen.js', 'scripts/sunday-review.js']) {
      assert.ok(!src(f).includes('auto_alerts'),
        `${f} mentions auto_alerts — an unattended job must not be able to create real alerts`);
    }
  });

  test('both call sites DEFAULT it to false', () => {
    assert.match(src('src/core/assessment_draw.js'), /auto_alerts = false,/,
      'drawFindings must default it off');
    assert.match(src('src/core/ticker_analyze.js'), /auto_alerts = false,/,
      'analyzeTicker must default it off');
    assert.match(src('src/core/ticker_analyze.js'), /earnings: earningsForDraw, auto_alerts \}/,
      'and pass the caller\'s value THROUGH — a default re-asserted at the call site is a second place '
      + 'for it to be wrong');
  });

  test('the option documents that a created alert is PERMANENT until manually deleted', () => {
    /**
     * There is no registry, no signature and no sweep for alerts — draw_clear and
     * removeOrphans are drawing machinery. If the opt-in does not say so, it is not
     * an informed one.
     */
    for (const f of ['src/core/assessment_draw.js', 'src/core/ticker_analyze.js']) {
      assert.match(src(f), /permanent until manually deleted/i,
        `${f}'s auto_alerts doc string must state that nothing here removes a created alert`);
      assert.match(src(f), /alert_delete/, `${f} must name the only cleanup path there is`);
    }
  });

  test('the drawer feeds it the DRAWN patterns and the merge tolerance, not a second opinion', () => {
    const d = src('src/core/assessment_draw.js');
    const call = d.slice(d.indexOf('drawn.alerts = await autoAlerts('));
    assert.match(call, /enabled: !!auto_alerts/);
    assert.match(call, /patterns: plan\.patterns/,
      'only patterns whose geometry is on the chart may carry an alert');
    assert.match(call, /tolerance_pct: merge\.tolerance_pct/,
      'one volatility rule for "these two prices are the same level", not two');
    assert.match(call, /max_age_bars: agePlan/, 'and the same freshness cutoff the geometry used');
  });

  test('alerts are outside the drawing cleanup machinery, and the module says so', () => {
    // Checked rather than assumed: if a sweep for alerts is ever added, this test
    // failing is the reminder that the doc strings above describe the old world.
    for (const f of ['src/core/orphans.js', 'src/core/drawing_registry.js', 'src/core/drawing.js']) {
      assert.ok(!/alert/i.test(src(f)),
        `${f} now mentions alerts — the "no cleanup story" documentation needs revisiting`);
    }
    assert.match(src('src/core/alert_plan.js'), /PERMANENT until someone deletes it by hand/);
  });
});
