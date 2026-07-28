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
  const SOURCES = ['scripts/sunday-review.js'];

  test('every `text:` template in the review has a matching signature', () => {
    const templates = new Set();
    for (const f of SOURCES) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/text: `([^`]*)`/g)) templates.add(m[1]);
    }
    assert.ok(templates.size >= 10, `only found ${templates.size} templates — did the extraction break?`);

    // Render each template with values of the right shape.
    const fill = (t) => t
      .replace(/\$\{label\}/g, 'double_bottom confirmed')
      .replace(/\$\{channel\.pattern\}/g, 'descending_channel')
      .replace(/\$\{side\}/g, 'long')
      .replace(/\$\{tag\}/g, 'double_bottom')
      .replace(/\$\{pauseBars\}/g, '8')
      .replace(/\$\{pv\.length\}/g, '3')
      .replace(/\$\{m\.pole_pct\}/g, '33.38')
      .replace(/\$\{m\.retrace_pct\}/g, '27.7')
      .replace(/\$\{a\.volatility_contraction\.pivot\}/g, '34.2')
      .replace(/\$\{r2\(neck, 2\)\}/g, '30.77')
      .replace(/\$\{r2\(taRow\.stop, 2\)\}/g, '1862.51')
      .replace(/\$\{l\.distance_pct\}/g, '-0.07')
      .replace(/\$\{l\.entry\}/g, '30.77')
      .replace(/\$\{l\.stop\}/g, '26.11')
      .replace(/\$\{l\.target\}/g, '34.76')
      .replace(/\$\{l\.rr\}/g, '0.86')
      .replace(/\$\{l\.price[^}]*\}/g, '34.93')
      .replace(/\$\{z\.bottom\}/g, '33.16')
      .replace(/\$\{z\.top\}/g, '34.2')
      .replace(/\$\{l\.label\}/g, 'S');

    const unmatched = [];
    for (const t of templates) {
      const rendered = fill(t);
      if (/\$\{/.test(rendered)) continue;          // template we cannot render — not a coverage claim
      if (!isMcpText(rendered)) unmatched.push({ template: t, rendered });
    }
    assert.deepEqual(unmatched, [],
      `these labels would leave permanently unrecoverable orphans:\n${JSON.stringify(unmatched, null, 2)}`);
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
