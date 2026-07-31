import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as registry from '../src/core/drawing_registry.js';
import { isMcpText, MCP_TEXT_SIGNATURES } from '../src/core/orphans.js';

describe('isMcpText — recognises what this toolchain writes', () => {
  const OURS = [
    'S 1277.33 (-0.07%)',
    'R 36.99 (5.5%)',
    'S 34.4752 (-1.67%)',
    'demand 33.16-34.2',
    'supply 1411.5-1573.09',
    'ENTRY long 30.77 — double_bottom',
    'ENTRY short 34.0979 — rising_wedge',
    'STOP 26.1123 — double_bottom',
    'TARGET 34.76 (R:R 0.86) — double_bottom',
    'TA stop 1862.51 (exit)',
    'double_bottom confirmed',
    'bull_flag forming pole +33.38%',
    'bear_flag forming pole +-41.98%',
    'bullish_pennant forming — 8 bars, 27.7% retrace',
    'double_bottom confirmed — breaks at 30.77',
    'bear_flag forming — completes 1222.01',
    'rising_wedge confirmed — only 3 pivots, too few to draw',
    'descending_channel upper',
    'rising_wedge confirmed upper',   // retired format, still on live charts
    'falling_wedge forming lower',
    'ascending_channel lower',
    'bullish_rectangle forming',
    'VCP pivot 34.2',
    // ta_draw_decision — these were leaking entirely until the 2026-07-28 audit
    'TA Call Wall 143.24',
    'TA Put Wall 1250',
    'TA BB Upper 99.5',
    'TA PIF Support 12.5',
    'TA Stop (CRITICAL) 598.37',
    'TA Stop (exit) 42',
    // walls_draw / walls_apply — tags joined with " / ", price suffixed
    'D Call Wall 1250',
    'W Put GEX 1180',
    'Gamma Flip 1195',
    'M Call Wall / D Put Wall 1195',
    'D Call Wall / W Call GEX / M Put Wall 900',
    // zones_draw rectangles — unregistered until draw-smoke's label audit
    // (P3.3, 2026-07-30) found every one of them invisible to the sweep
    'demand fresh · 2.1x',
    'supply tested · 1.4x',
    'demand fresh · aggressive · 3.04x',
    'supply broken · aggressive · 2x',   // integer multiple; broken reachable via include_broken
    'demand tested · 12.75x',
    'supply fresh · nullx',              // avgBody 0 → momentum_x null → String(null); RETIRED
                                         // wording, still on live charts — append-only
    'demand fresh · n/a',                // what the emitter writes for that case since 2026-07-30
    'supply tested · aggressive · n/a',
  ];

  for (const t of OURS) {
    test(`recognises ${JSON.stringify(t)}`, () => {
      assert.equal(isMcpText(t), true);
    });
  }
});

describe('isMcpText — leaves everything else alone', () => {
  /**
   * The asymmetry that governs this module: missing an orphan costs a stale
   * line, a false match deletes the user's analysis. Anything plausible a
   * person might type must NOT match.
   */
  const THEIRS = [
    'my support',
    'watch this',
    'Support',
    'buy zone',
    'S',
    'R',
    'entry',
    'ENTRY',
    'target 2',
    'TARGET',
    'stop',
    'demand',
    'supply',
    'double_bottom',                  // a bare pattern name, hand-typed
    'S 1277.33',                      // ours always carries the percentage
    'R 36.99 (5.5)',                  // missing the % sign
    'demand 33.16',                   // ours always carries both bounds
    'ENTRY long — double_bottom',     // no price
    'TA stop',
    'note: S 1277.33 (-0.07%)',       // our format EMBEDDED in a person's note
    'S 1277.33 (-0.07%) — my note',   // ours with something appended
    'VCP',
    'TA Call Wall',                   // no price
    'Call Wall 1250',                 // no TA prefix and no horizon
    'my TA Stop 100',                 // prefixed by a person
    'D Call Wall 1250 — mine',        // ours with something appended
    'demand fresh',                   // hand-typed shorthand — ours always carries the momentum suffix
    'demand fresh · 2.1',             // missing the x
    'demand fresh - 2.1x',            // ASCII hyphen, not the middle dot the builder writes
    'demand fresh - n/a',             // the hyphen rule again, for the n/a form
    'demand fresh · plain · 2.1x',    // 'plain' is a real grade but is never printed
    'supply aggressive · 2.1x',       // the builder always prints the status
    'note: demand fresh · 2.1x',      // our format embedded in a person's note
    'demand fresh · 2.1x — mine',     // ours with something appended
    '',
    '   ',
  ];

  for (const t of THEIRS) {
    test(`leaves ${JSON.stringify(t)} alone`, () => {
      assert.equal(isMcpText(t), false, `"${t}" would have been deleted`);
    });
  }

  test('a shape with no text is never ours', () => {
    // Most hand-drawn shapes carry no label at all, so this is the single
    // most important negative in the module.
    for (const v of [null, undefined, 0, false, {}, []]) {
      assert.equal(isMcpText(v), false);
    }
  });
});

describe('signatures cover every label format the code writes', () => {
  /**
   * The failure this guards against is silent and permanent: change a drawing
   * label's format, forget to update MCP_TEXT_SIGNATURES, and every orphan it
   * leaves behind becomes unrecoverable — invisible to the safe scope forever.
   *
   * So the template literals are lifted straight out of the source and each one
   * is rendered with plausible values and fed through the matcher.
   */
  /**
   * EVERY file that writes a drawing label. The audit found ta_decisions.js and
   * ta_walls.js writing labels no signature matched, so every level
   * ta_draw_decision and the walls overlay had ever drawn was a permanent
   * orphan.
   *
   * The review's own labels now live in src/core/assessment_draw.js — extracted
   * so the morning screen draws from one implementation. This test's
   * "did the extraction break?" guard is what caught the move.
   *
   * Substitutions are PER FILE, because the same placeholder means different
   * things in different files: `${l.label}` is "S"/"R" in the review and
   * "TA Call Wall" in ta_decisions. A shared map silently renders one of them
   * wrong and the test then fails for the wrong reason.
   */
  const COMMON = [
    [/\$\{channel\.pattern\}/g, 'descending_channel'],
    [/\$\{side\}/g, 'long'],
    [/\$\{tag\}/g, 'double_bottom'],
    [/\$\{pauseBars\}/g, '8'],
    [/\$\{pv\.length\}/g, '3'],
    [/\$\{m\.pole_pct\}/g, '33.38'],
    [/\$\{m\.retrace_pct\}/g, '27.7'],
    [/\$\{a\.volatility_contraction\.pivot\}/g, '34.2'],
    [/\$\{r2\(neck, 2\)\}/g, '30.77'],
    [/\$\{r2\(taRow\.stop, 2\)\}/g, '1862.51'],
    [/\$\{l\.distance_pct\}/g, '-0.07'],
    [/\$\{l\.entry\}/g, '30.77'],
    [/\$\{l\.stop\}/g, '26.11'],
    [/\$\{l\.target\}/g, '34.76'],
    [/\$\{l\.rr\}/g, '0.86'],
    [/\$\{z\.bottom\}/g, '33.16'],
    [/\$\{z\.top\}/g, '34.2'],
  ];
  const SOURCES = [
    { file: 'src/core/assessment_draw.js', fill: [
      [/\$\{label\}/g, 'double_bottom confirmed'],
      [/\$\{l\.label\}/g, 'S'],
      [/\$\{l\.price[^}]*\}/g, '34.93'],
      ...COMMON,
    ] },
    { file: 'src/core/ta_decisions.js', fill: [
      [/\$\{l\.label\}/g, 'TA Call Wall'],
      [/\$\{l\.price >= 100[\s\S]*?\)\}/g, '143.24'],
    ] },
    { file: 'src/core/ta_walls.js', fill: [
      [/\$\{label\}/g, 'D Call Wall / W Put GEX'],
      [/\$\{l\.price\}/g, '1250'],
    ] },
  ];

  test('every drawing label in the codebase has a matching signature', () => {
    const templates = [];
    for (const { file, fill } of SOURCES) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/text: `([^`]*)`/g)) templates.push({ file, t: m[1], fill });
    }
    assert.ok(templates.length >= 12, `only found ${templates.length} templates — did the extraction break?`);

    const unmatched = [];
    for (const { file, t, fill } of templates) {
      const rendered = fill.reduce((s, [re, v]) => s.replace(re, v), t);
      if (/\$\{/.test(rendered)) continue;          // template we cannot render — not a coverage claim
      if (!isMcpText(rendered)) unmatched.push({ file, template: t, rendered });
    }
    assert.deepEqual(unmatched, [],
      `these labels would leave permanently unrecoverable orphans:\n${JSON.stringify(unmatched, null, 2)}`);
  });
});

describe('zones_draw labels — the builder and the signature stay in step', () => {
  /**
   * zones_draw builds its label into a variable before handing it to drawShape,
   * so the `text: \`...\`` scan above cannot see it — which is exactly how it
   * shipped unregistered and leaked (draw-smoke's label audit, P3.3,
   * 2026-07-30). So this block pins the template VERBATIM: if the builder's
   * label line changes in any way, the first assertion fails and says to update
   * the signature and this test together. The render below is the same
   * expression with local variables, so it cannot drift from what is pinned.
   */
  // The momentum slot is ALWAYS filled — "n/a" when the multiple is
  // unmeasurable (zero-body base), never String(null)'s "nullx". Dropping the
  // suffix instead was considered and rejected: the bare "demand fresh" is
  // pinned as hand-typed in the negatives above, so a suffixless emission
  // could never be claimed by the sweep without risking a person's own label.
  const TEMPLATE = "${z.kind} ${z.status}${z.grade === 'aggressive' ? ' · aggressive' : ''} · ${z.momentum_x == null ? 'n/a' : z.momentum_x + 'x'}";

  test('every form the builder can emit is recognised', () => {
    const src = readFileSync('src/tools/zones.js', 'utf8');
    const m = src.match(/const label = `([^`]+)`/);
    assert.ok(m, 'zones_draw no longer builds `label` where this test expects — '
      + 'update this test AND the zones signature in orphans.js together');
    assert.equal(m[1], TEMPLATE, 'the label template changed — every NEW wording '
      + 'needs a signature appended in orphans.js (never narrowed), then update this test');

    // The real vocabularies (src/core/zones.js): kind from the departure
    // direction, status from broken/tests, grade from the three aggression
    // flags, momentum_x = round(x, 2) — a number or null.
    for (const kind of ['demand', 'supply']) {
      for (const status of ['fresh', 'tested', 'broken']) {
        for (const grade of ['aggressive', 'plain']) {
          for (const momentum_x of [2, 2.1, 3.04, null]) {
            const label = `${kind} ${status}${grade === 'aggressive' ? ' · aggressive' : ''} · ${momentum_x == null ? 'n/a' : momentum_x + 'x'}`;
            assert.equal(isMcpText(label), true,
              `would leak as a permanently unrecoverable orphan: "${label}"`);
          }
        }
      }
    }
  });

  test('the vocabularies the signature enumerates still exist in src/core/zones.js', () => {
    // The signature hard-codes demand|supply, fresh|tested|broken and
    // ' · aggressive'. If any of these expressions change in the core, the
    // label space changes with them: re-derive it, EXTEND the signature in
    // orphans.js (never narrow — signatures are append-only), then update this.
    const core = readFileSync('src/core/zones.js', 'utf8');
    assert.ok(core.includes("bullish ? 'demand' : 'supply'"), 'kind vocabulary moved or changed');
    assert.ok(core.includes("broken ? 'broken' : t.tests === 0 ? 'fresh' : 'tested'"), 'status vocabulary moved or changed');
    assert.ok(core.includes("aggressive ? 'aggressive' : 'plain'"), 'grade vocabulary moved or changed');
  });
});

describe('signatures are append-only', () => {
  test('retired label formats are still recognised', () => {
    // An orphan was written by OLD code. If signatures only cover what the
    // current code emits, the oldest drawings are precisely the ones that can
    // never be cleaned up. Found live on CQTM on 2026-07-28.
    assert.equal(isMcpText('rising_wedge confirmed upper'), true);
    assert.equal(isMcpText('rising_wedge confirmed lower'), true);
  });
});

describe('MCP_TEXT_SIGNATURES — anchored, not substring', () => {
  test('every signature is anchored at both ends', () => {
    // An unanchored pattern matches our format buried inside a person's note,
    // which is how a cleanup tool starts deleting someone's annotations.
    for (const re of MCP_TEXT_SIGNATURES) {
      const s = re.source;
      assert.ok(s.startsWith('^'), `not anchored at start: ${s}`);
      assert.ok(s.endsWith('$'), `not anchored at end: ${s}`);
    }
  });
});

describe('drawnSymbols — the record of WHERE to sweep', () => {
  const tmp = join(tmpdir(), `reg-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const clean = () => { try { rmSync(tmp); } catch { /* fine */ } };

  test('remembers a symbol after every drawing on it is forgotten', () => {
    // The exact failure this fixes: prune/forget empty `entries` when the
    // TradingView session ends, taking the only record of which charts were
    // drawn on with them. CARG kept 17 shapes through a full sweep this way.
    clean();
    registry.record([{ entity_id: 'a1' }, { entity_id: 'a2' }], { symbol: 'BATS:CARG', path: tmp });
    assert.deepEqual(registry.drawnSymbols({ path: tmp }), ['BATS:CARG']);

    registry.forget(['a1', 'a2'], { path: tmp });
    assert.equal(registry.list({ path: tmp }).length, 0, 'entries should be empty');
    assert.deepEqual(registry.drawnSymbols({ path: tmp }), ['BATS:CARG'],
      'the symbol was forgotten along with its entity ids');
    clean();
  });

  test('survives a prune that drops every id as dead', () => {
    clean();
    registry.record([{ entity_id: 'b1' }], { symbol: 'BATS:VOO', path: tmp });
    registry.prune([], { symbol: 'BATS:VOO', path: tmp });   // nothing live
    assert.equal(registry.list({ path: tmp }).length, 0);
    assert.deepEqual(registry.drawnSymbols({ path: tmp }), ['BATS:VOO']);
    clean();
  });

  test('does not duplicate a symbol drawn on repeatedly', () => {
    clean();
    for (let i = 0; i < 5; i++) {
      registry.record([{ entity_id: `c${i}` }], { symbol: 'BATS:SHAZ', path: tmp });
    }
    assert.deepEqual(registry.drawnSymbols({ path: tmp }), ['BATS:SHAZ']);
    clean();
  });

  test('an empty or missing store yields an empty list, not a throw', () => {
    clean();
    assert.deepEqual(registry.drawnSymbols({ path: tmp }), []);
  });
});
