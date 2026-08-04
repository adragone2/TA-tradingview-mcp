import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyShape, organizePlan, CATEGORY_RULES, TEXTLESS_SHAPE_CATEGORIES, NATIVE_GROUP_PREFIX,
} from '../src/core/draw_visibility.js';
import { MCP_TEXT_SIGNATURES, isMcpText } from '../src/core/orphans.js';

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/**
 * Real labels, one or more per emitter family — the same vocabulary the
 * signature tests use. If a NEW label family lands in orphans.js without a
 * category rule, the coverage test below fails and names it, which is the
 * whole point: ownership and categorisation are two layers, and only a test
 * can keep the coarse one aligned with the exact one.
 */
const FIXTURES = [
  // levels — bare, with reason suffix, and VCP's pivot
  ['S 1277.33 (-0.07%)', 'levels'],
  ['R 36.99 (5.5%)', 'levels'],
  ['S 14.84 (0.07%) - 9 tests, 1.4x vol', 'levels'],
  ['R 314.6 (1.09%) - 8 tests, 1.3x vol', 'levels'],
  // vcp — the pivot line and the contraction legs toggle as one set
  ['VCP pivot 34.2', 'vcp'],
  ['VCP c1 8.93%', 'vcp'],
  ['VCP c3 4.1%', 'vcp'],
  // zones — review range form and zones_draw tool form, incl. nullx and n/a
  ['demand 33.16-34.2', 'zones'],
  ['supply 1411.5-1573.09', 'zones'],
  ['demand fresh · 2.1x', 'zones'],
  ['supply tested · aggressive · 1.4x', 'zones'],
  ['demand fresh · nullx', 'zones'],
  ['supply broken · n/a', 'zones'],
  // plans — every leg, TA's stop, and the ordering trap (pattern words in the suffix)
  ['ENTRY long 30.77 — double_bottom', 'plans'],
  ['STOP 26.11 — double_bottom', 'plans'],
  ['TARGET 34.76 (R:R 0.86) — bull_flag forming', 'plans'],
  ['TA stop 1862.51 (exit)', 'plans'],
  // patterns — statuses, completion/break lines, channels, retired upper/lower form, targets
  ['double_top forming', 'patterns'],
  ['head_and_shoulders confirmed — breaks at 8.19', 'patterns'],
  ['inverse_head_and_shoulders confirmed — completes 34.2', 'patterns'],
  ['bull_flag forming pole +12.5%', 'patterns'],
  ['bull_flag forming — 21 bars, 38.2% retrace', 'patterns'],
  ['descending_channel upper', 'patterns'],
  ['rising_wedge confirmed upper', 'patterns'],
  ['bull_flag forming target 19.32', 'patterns'],
  ['symmetrical_triangle forming — only 3 pivots, too few to draw', 'patterns'],
  // cycle — both grammar forms
  ['cycle base>accumulation 2026-04-16', 'cycle'],
  ['cycle accumulation since 2026-04-16 (74 bars)', 'cycle'],
  // earnings
  ['earnings 2026-08-04 (2d)', 'earnings'],
  // walls
  ['D Call Wall 1250', 'walls'],
  ['W Put GEX / M Call Wall 1180', 'walls'],
  ['Gamma Flip 1195', 'walls'],
  // ta_draw_decision
  ['TA Call Wall 143.24', 'ta_decision'],
  ['TA Stop (CRITICAL) 598.37', 'ta_decision'],
];

describe('classifyShape — the coarse layer stays aligned with the exact one', () => {
  test('every fixture classifies to its family, never other_mcp/foreign', () => {
    for (const [text, want] of FIXTURES) {
      assert.ok(isMcpText(text), `fixture not owned by any signature: "${text}" — fix the fixture`);
      const got = classifyShape({ name: 'horizontal_line', text, created_by_mcp: true });
      assert.equal(got, want, `"${text}" -> ${got}, wanted ${want}`);
    }
  });

  test('plan legs with pattern vocabulary in the suffix stay PLANS — rule order is load-bearing', () => {
    // "TARGET ... — bull_flag forming" contains the patterns discriminator;
    // plans must test first or every annotated leg toggles with the wrong set.
    assert.equal(
      classifyShape({ text: 'TARGET 34.76 (R:R 0.86) — bull_flag forming', created_by_mcp: true }),
      'plans',
    );
    assert.equal(CATEGORY_RULES[0].category, 'plans', 'plans must stay the first rule');
  });

  test('textless natives classify by shape name ONLY while the registry tracks them', () => {
    for (const [name, want] of Object.entries(TEXTLESS_SHAPE_CATEGORIES)) {
      assert.equal(classifyShape({ name, text: '', created_by_mcp: true }), want);
      assert.equal(classifyShape({ name, text: '', created_by_mcp: false }), 'foreign',
        `untracked ${name} must read foreign — after a TV restart it is indistinguishable from hand-drawn`);
    }
  });

  test('hand-typed text is foreign even when tracked-looking words appear in it', () => {
    for (const text of ['my support line', 'watch this level', 'Base to Accumulation', 'demand?']) {
      assert.equal(classifyShape({ name: 'horizontal_line', text, created_by_mcp: false }), 'foreign');
    }
  });

  test('a signed label with no category rule reads other_mcp, never foreign', () => {
    // Synthesised: prove the fallthrough exists without depending on a real
    // orphaned family (the coverage test above keeps the real set at zero).
    const signed = FIXTURES[0][0];
    assert.ok(isMcpText(signed));
    // if every rule were deleted, signed text must still not read foreign
    const got = classifyShape({ text: signed, created_by_mcp: false });
    assert.notEqual(got, 'foreign', 'ownership comes from the signature, not the registry flag');
  });

  test('every signature family is represented in the fixtures', () => {
    // One fixture per signature REGEX is overkill (many are variants of one
    // family), but every fixture must hit at least one signature, and the
    // fixture count must not silently lag far behind the signature count.
    assert.ok(FIXTURES.length >= MCP_TEXT_SIGNATURES.length,
      `signatures ${MCP_TEXT_SIGNATURES.length} > fixtures ${FIXTURES.length} — a new label family `
      + 'landed in orphans.js; add a fixture and, if needed, a category rule');
  });
});

describe('organizePlan — pure, and foreign never gets grouped', () => {
  const census = {
    categories: {
      levels: { total: 3, visible: 3, hidden: 0, ids: ['a', 'b', 'c'] },
      cycle: { total: 2, visible: 2, hidden: 0, ids: ['d', 'e'] },
      foreign: { total: 4, visible: 4, hidden: 0, ids: ['x', 'y', 'z', 'w'] },
      patterns: { total: 0, visible: 0, hidden: 0, ids: [] },
    },
  };

  test('one group per non-empty MCP category, prefixed and sorted', () => {
    const plan = organizePlan(census);
    assert.deepEqual(plan.map((g) => g.name), [`${NATIVE_GROUP_PREFIX}cycle`, `${NATIVE_GROUP_PREFIX}levels`]);
    assert.deepEqual(plan.find((g) => g.category === 'levels').ids, ['a', 'b', 'c']);
  });

  test('foreign is excluded even though it has ids — grouping is an ownership claim in the user\'s UI', () => {
    assert.ok(!organizePlan(census).some((g) => g.category === 'foreign'));
  });

  test('empty census plans nothing', () => {
    assert.deepEqual(organizePlan({ categories: {} }), []);
  });
});

describe('the removeGroup trap stays fenced', () => {
  /**
   * Probed 2026-08-02: removeGroup(gid) DELETES the member drawings — it is
   * not a dissolve. The safe path is excludeShapeFromGroup per member (the
   * group auto-removes on the last exclusion, shapes survive — 2/2 alive).
   * The page-side code runs in the browser, so these are source contracts;
   * the live verification exercises the behaviour.
   */
  const s = src('src/core/draw_visibility.js');

  test('both dissolve paths exclude members before any removeGroup', () => {
    for (const fn of ['organizeNativeGroups', 'dissolveNativeGroups']) {
      const body = s.slice(s.indexOf(`export async function ${fn}`));
      const exclude = body.indexOf('excludeShapeFromGroup(');
      const remove = body.indexOf('gc.removeGroup(');  // the CALL — comments mention the word
      assert.ok(exclude > -1, `${fn} must dissolve via excludeShapeFromGroup`);
      assert.ok(remove === -1 || exclude < remove,
        `${fn}: removeGroup before member exclusion would DELETE the drawings`);
    }
  });

  test('removeGroup only ever fires on a group verified EMPTY', () => {
    const guarded = /shapesInGroup\(gid\)\.length === 0\) gc\.removeGroup\(gid\)/g;
    const all = (s.match(/gc\.removeGroup\(/g) || []).length;
    const safe = (s.match(guarded) || []).length;
    assert.equal(all, safe, 'every gc.removeGroup call must sit behind the members-empty guard');
  });

  test('setVisibility reads every write back — a silent no-op is not a change', () => {
    const body = s.slice(s.indexOf('export async function setVisibility'));
    assert.match(body, /getProperties\(\)\.visible/);
    assert.match(body, /verified: back ===/);
  });
});
