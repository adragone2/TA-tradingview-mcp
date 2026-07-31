/**
 * docs/strategies.md must render indicator OBJECTS, not their default
 * stringification.
 *
 * `indicators` in strategies.json is a list of {study, label, inputs?,
 * external?} objects (see _indicator_schema there), but gen-strategies-doc.js
 * formatted them with the same helper used for plain string arrays — so every
 * strategy's "TradingView indicators" row read "[object Object], [object
 * Object]", 17 rows at once, and nothing failed. Same guard style as
 * doc_counts.test.js: derive the expected text from the file the code reads
 * and assert the checked-in doc agrees, so a stale or mis-rendered doc fails
 * here instead of being quietly believed.
 *
 * Run: node --test tests/strategies_doc.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc = readFileSync(join(ROOT, 'docs', 'strategies.md'), 'utf8');
const { strategies } = JSON.parse(readFileSync(join(ROOT, 'strategies.json'), 'utf8'));

describe('docs/strategies.md renders indicator objects', () => {
  it('contains no default object stringification', () => {
    const hits = (doc.match(/\[object Object\]/g) || []).length;
    assert.equal(hits, 0,
      `docs/strategies.md contains "[object Object]" ${hits} time(s) — the generator `
      + 'is formatting indicator objects as strings. Fix the formatter and re-run '
      + 'node scripts/gen-strategies-doc.js.');
  });

  it('names every indicator by its label (or study)', () => {
    for (const [key, spec] of Object.entries(strategies)) {
      for (const ind of spec.indicators || []) {
        const name = ind.label || ind.study;
        assert.ok(name, `${key}: an indicator has neither label nor study.`);
        assert.ok(doc.includes(name),
          `${key}: indicator "${name}" does not appear in docs/strategies.md.`);
      }
    }
  });

  it('does not present an external indicator as an addable TradingView study', () => {
    // short_term_reversal carries {study: null, external: true} — there is no
    // study name chart_manage_indicator could take, so the doc must not format
    // it like one (backticks are how the doc marks real study names).
    const externals = Object.values(strategies)
      .flatMap((s) => s.indicators || []).filter((i) => i.external || !i.study);
    assert.ok(externals.length > 0,
      'expected at least one external indicator in strategies.json — if they were '
      + 'all removed, delete this assertion, not the test above.');
    for (const ind of externals) {
      const name = ind.label || ind.study;
      assert.ok(!doc.includes(`\`${name}\``),
        `"${name}" is external (not a TradingView study) but the doc wraps it in `
        + 'backticks like an addable study name.');
    }
  });
});
