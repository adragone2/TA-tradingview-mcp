import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

/**
 * Every tool that READS THE CHART must say which symbol it read.
 *
 * This is a source contract rather than a behavioural test because the failure it
 * guards against needs a live chart and a race to reproduce. What happened: a
 * background `morning-screen.js` run drives the chart symbol by symbol, and during
 * a DLO analysis it moved the chart underneath the tools. Reads came back holding
 * BATS:AMLX, then BATS:EVRG, then BATS:ZGN data.
 *
 * The tools that stamped a symbol were caught instantly. The ones that did not —
 * structure_analyze, legs_classify, levels_find, strategy_check, divergence_survey
 * — returned another company's numbers in a shape indistinguishable from correct
 * output. They were only caught by hand-matching swing prices against a tool that
 * did stamp it, and one of them had already reached a written report.
 *
 * So: a chart read that cannot be attributed to a symbol is not evidence.
 */
const src = (p) => readFileSync(p, 'utf8');

/**
 * Body of a named function, by counting braces.
 *
 * Not "up to the first column-0 `}`": these functions destructure their arguments
 * across several lines, so that naive version returned only the parameter list and
 * the test passed or failed on the signature rather than the body.
 */
function bodyOf(text, name) {
  const re = new RegExp(`(export )?(async )?function ${name}\\s*\\(`);
  const m = text.match(re);
  if (!m) return null;
  // Skip the parameter list first — these functions destructure their arguments,
  // so counting from the first `{` would close on the parameters, not the body.
  let i = m.index + m[0].length - 1;
  let parens = 0;
  for (; i < text.length; i += 1) {
    if (text[i] === '(') parens += 1;
    else if (text[i] === ')') { parens -= 1; if (parens === 0) { i += 1; break; } }
  }
  const open = text.indexOf('{', i);
  if (open === -1) return null;
  let depth = 0;
  for (let j = open; j < text.length; j += 1) {
    if (text[j] === '{') depth += 1;
    else if (text[j] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(m.index, j + 1);
    }
  }
  return text.slice(m.index);
}

const READERS = [
  ['src/core/structure.js', 'analyzeStructure', 'structure_analyze'],
  ['src/core/structure.js', 'keyLevels', 'levels_find'],
  ['src/core/structure.js', 'drawKeyLevels', 'levels_draw'],
  ['src/core/strategy.js', 'checkStrategy', 'strategy_check'],
];

describe('every chart read is attributable to a symbol', () => {
  for (const [file, fn, tool] of READERS) {
    test(`${tool} (${fn}) returns the symbol it read`, () => {
      const body = bodyOf(src(file), fn);
      assert.ok(body, `could not find ${fn} in ${file}`);
      assert.match(
        body, /\bsymbol\b/,
        `${tool} does not return a symbol. A background scan can move the chart mid-analysis, `
        + 'and a read that does not say what it read cannot be checked against what was asked for.',
      );
    });
  }

  test('legs_classify and divergence_survey stamp the symbol', () => {
    const t = src('src/tools/divergence.js');
    // Both destructure the symbol out of loadBars and put it in the response.
    const uses = t.match(/const \{ bars, symbol, timeframe \} = await loadBars\(/g) || [];
    assert.ok(uses.length >= 3, `expected every loadBars caller to take the symbol, found ${uses.length}`);
    assert.match(t, /success: true,\s*symbol,\s*timeframe,/,
      'legs_classify must return symbol and timeframe');
  });

  test('the bar loaders carry the symbol rather than discarding it', () => {
    for (const f of ['src/core/structure.js', 'src/tools/divergence.js']) {
      const body = bodyOf(src(f), 'loadBars');
      assert.ok(body, `no loadBars in ${f}`);
      assert.match(body, /return \{ bars, symbol:/,
        `${f}: loadBars must return the symbol alongside the bars`);
    }
  });

  test('the reason is recorded next to the code, not only in a commit message', () => {
    // A future edit that drops the symbol should have to delete this explanation.
    assert.match(src('src/core/structure.js'), /BATS:ZGN|another company's data/,
      'core/structure.js must keep the note explaining why the symbol travels with the bars');
  });
});
