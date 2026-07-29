import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

/**
 * The schema doc is a CONTRACT — TA imports against it. When it drifts from
 * what the script emits, code written from the doc compiles, passes its own
 * tests, and returns nulls in production.
 *
 * That already happened: a consumer read `ta_validation.ta_action`, which the
 * doc documented and the script did not return, so a detail pane would have
 * rendered "TA said: None (None)" on all 50 rows. Tests written from the doc
 * would have passed the whole time.
 *
 * The doc is therefore checked against the SOURCE, not against a report. A
 * report is one run's output and can predate a fix — which is exactly how the
 * mismatch was found, and why it looked live when it was not. The source is
 * what runs next Sunday.
 */

/**
 * Both files normalised to LF on read.
 *
 * Every extractor below anchors on a literal newline and this repo is checked
 * out CRLF. An un-normalised anchor makes indexOf return -1, which slices from
 * the END of the string and then reports every documented field as missing.
 * The audit's own frontmatter check made this mistake and declared all 17
 * skills broken; the first draft of this file made it too.
 */
const lf = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const DOC = lf('docs/sunday-review-schema.md');
const SRC = lf('scripts/sunday-review.js');

/** Field names quoted inside a doc section's jsonc blocks. */
function documentedKeys(sectionHeading) {
  const start = DOC.indexOf(sectionHeading);
  assert.ok(start >= 0, `section "${sectionHeading}" is gone from the schema doc`);
  const rest = DOC.slice(start);
  const end = rest.indexOf('\n## ', 1);
  const section = end > 0 ? rest.slice(0, end) : rest;
  const keys = new Set();
  for (const block of section.matchAll(/```jsonc?\n([\s\S]*?)```/g)) {
    for (const m of block[1].matchAll(/^\s*"([a-z_][a-z0-9_]*)"\s*:/gim)) keys.add(m[1]);
  }
  assert.ok(keys.size > 0, `no documented keys parsed from "${sectionHeading}" — extraction broke`);
  return [...keys];
}

describe('the schema doc matches what the script emits', () => {
  test('every ta_validation key in the doc is actually returned', () => {
    const ret = SRC.slice(SRC.indexOf('function validateTa'));
    assert.ok(ret.length > 200, 'could not locate validateTa');
    const body = ret.slice(0, ret.indexOf('\n}\n'));
    // Shorthand properties share a line — `agreement, supports, conflicts,` —
    // so match every identifier on a property line, not just the first. The
    // first draft caught only the leading name and reported four live fields
    // as missing.
    const emitted = new Set();
    for (const line of body.split('\n')) {
      if (!/^\s{4}\S/.test(line)) continue;
      for (const m of line.matchAll(/([a-z_][a-z0-9_]*)\s*[:,]/g)) emitted.add(m[1]);
    }
    emitted.add('also_listed_as');            // spread in by the caller

    const missing = documentedKeys('## `ta_validation`').filter((k) => !emitted.has(k));
    assert.deepEqual(missing, [],
      `documented but never emitted: ${missing.join(', ')} — a consumer reading these gets null.\n`
      + `Actually emitted: ${[...emitted].sort().join(', ')}`);
  });

  test('every trade_plans key in the doc is actually returned', () => {
    const block = SRC.slice(SRC.indexOf('const trade_plans = safe('));
    assert.ok(block.length > 100, 'could not locate the trade_plans block');
    const body = block.slice(0, block.indexOf('), []);'));
    const emitted = new Set([...body.matchAll(/([a-z_][a-z0-9_]*):/g)].map((m) => m[1]));
    // Leg-level keys are built in pattern_trades.js, not here.
    for (const k of ['side', 'entry', 'stop', 'target', 'risk', 'reward', 'rr', 'note', 'long', 'short']) emitted.add(k);
    const missing = documentedKeys('### `trade_plans`').filter((k) => !emitted.has(k));
    assert.deepEqual(missing, [], `documented but never emitted: ${missing.join(', ')}`);
  });

  test('every assessment block the doc names exists in the emitted object', () => {
    const rows = [...DOC.matchAll(/^\|\s*`([a-z_]+)`\s*\|\s*[a-z-]+\s*\|/gm)].map((m) => m[1]);
    assert.ok(rows.length >= 15, `only ${rows.length} blocks parsed from the doc table — extraction broke`);
    const returnBlock = SRC.slice(SRC.indexOf('  return {\n    price: r2(px, 4),'));
    assert.ok(returnBlock.length > 200, 'could not locate the assess() return block');
    const emitted = returnBlock.slice(0, returnBlock.indexOf('\n  };'));
    assert.ok(emitted.length > 200, 'the assess() return block came back empty');
    const missing = rows.filter((k) => !new RegExp(`(^|[\\s,{])${k}[,:\\s]`, 'm').test(emitted));
    assert.deepEqual(missing, [], `assessment blocks documented but not emitted: ${missing.join(', ')}`);
  });

  test('the doc does not promise a schema_version the script does not set', () => {
    const docVer = DOC.match(/"schema_version":\s*"([\d.]+)"/)?.[1];
    const srcVer = SRC.match(/SCHEMA_VERSION\s*=\s*'([\d.]+)'/)?.[1];
    assert.equal(docVer, srcVer, `doc says ${docVer}, script sets ${srcVer}`);
  });
});

describe('stale reports cannot be mistaken for the contract', () => {
  const reports = () => (existsSync('reports')
    ? readdirSync('reports').filter((x) => x.endsWith('.json'))
    : []);

  test('every report in reports/ was produced by the current schema version', () => {
    const srcVer = SRC.match(/SCHEMA_VERSION\s*=\s*'([\d.]+)'/)?.[1];
    for (const f of reports()) {
      const rep = JSON.parse(readFileSync(`reports/${f}`, 'utf8'));
      assert.equal(rep.schema_version, srcVer, `reports/${f} is schema ${rep.schema_version}, current is ${srcVer}`);
    }
  });

  test('no report in reports/ has ta_action null on every row', () => {
    /**
     * The specific stale artifact that misled a consumer. A field null on ALL
     * rows is not a fact about the market — it is a signal that the run
     * predates a fix. Anything written against such a report inherits the bug,
     * and its own tests pass.
     */
    for (const f of reports()) {
      const rep = JSON.parse(readFileSync(`reports/${f}`, 'utf8'));
      const rows = (rep.tickers || []).filter((t) => t.ta_validation);
      if (rows.length < 5) continue;
      const nulls = rows.filter((t) => t.ta_validation.ta_action == null).length;
      assert.notEqual(nulls, rows.length,
        `reports/${f}: ta_action is null on all ${rows.length} rows — this report predates the fix. `
        + 'Regenerate or delete it before writing anything against it.');
    }
  });
});
