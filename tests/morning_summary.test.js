import { test, describe } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The summary script runs UNATTENDED at 05:30 and nobody is awake to read a stack
 * trace. It replaced `node -e <hand-rolled extraction>` in the scheduled prompt for
 * two reasons: that needed an arbitrary-code permission, and extraction written
 * fresh each morning is written against remembered key names — schema 3.0 renamed
 * most of them, and a key that no longer exists returns `undefined` rather than
 * throwing, so a section vanishes from the summary in silence.
 *
 * These tests exist so the key names cannot drift from the report again without
 * something failing loudly.
 */

const run = (args = [], opts = {}) => execFileSync(
  process.execPath, ['scripts/morning-summary.js', ...args],
  { encoding: 'utf8', cwd: process.cwd(), ...opts },
);

describe('it survives a missing or broken report', () => {
  test('a missing file exits NON-ZERO rather than printing nothing', () => {
    /**
     * The dangerous failure is exiting 0 with an empty summary: the routine would
     * report a clean morning when the run never produced anything.
     */
    let code = 0;
    let stderr = '';
    try {
      run(['--file', join(tmpdir(), 'definitely-not-here.json')], { stdio: 'pipe' });
    } catch (e) {
      code = e.status;
      stderr = String(e.stderr || '');
    }
    assert.notEqual(code, 0, 'a missing report must fail the command');
    assert.match(stderr, /Do NOT summarise an older report/,
      'and must warn against falling back to yesterday, which would read as today');
  });

  test('a corrupt report fails the same way', () => {
    const d = mkdtempSync(join(tmpdir(), 'msum-'));
    const f = join(d, 'bad.json');
    writeFileSync(f, '{ not json');
    let code = 0;
    try { run(['--file', f], { stdio: 'pipe' }); } catch (e) { code = e.status; }
    assert.notEqual(code, 0);
  });
});

describe('against the real report', () => {
  const REAL = 'reports/morning-screen-latest.json';
  const have = existsSync(REAL);

  test('it runs clean and prints every section the scheduled prompt promises', { skip: !have && 'no report yet' }, () => {
    const out = run();
    /**
     * Each of these is a line STEP 4 of the scheduled prompt tells the agent to
     * report. If the script stops emitting one, the morning summary silently loses
     * a section — which is exactly the failure the script was written to prevent.
     */
    for (const heading of [
      'MORNING SCREEN', 'GATE —', 'PER SCREEN:', 'WATCHLIST:', 'TICKERS:',
      'MOVED SINCE THE BAR', 'LIVE TRADE PLANS', 'TRIALS:', 'NOT ADVICE',
    ]) {
      assert.ok(out.includes(heading), `the summary lost its "${heading}" section`);
    }
  });

  test('it never prints undefined — that is what a renamed key looks like', { skip: !have && 'no report yet' }, () => {
    /**
     * The specific silent failure. `selection.trials`, `selection.considered` and
     * `our_view.bias` all disappeared between schema 2.x and 3.0, and reading one
     * yields `undefined`, not an error.
     */
    const out = run();
    assert.ok(!/\bundefined\b/.test(out), 'a key the script reads no longer exists in the report');
    assert.ok(!/\bNaN\b/.test(out), 'a number the script formats is not a number');
    assert.ok(!/\[object Object\]/.test(out), 'an object is being printed where a value was meant');
  });

  test('the gate is reported, because it is what makes the list mean anything', { skip: !have && 'no report yet' }, () => {
    // The detectors chose the list, not the scanner. That is the whole of schema 3.0
    // and the first number the summary is supposed to lead with.
    assert.match(run(), /GATE — \d+\/\d+ unique symbols survived our detectors/);
  });

  test('the summary is compact enough to paste into a conversation', { skip: !have && 'no report yet' }, () => {
    // The report itself is several MB. The point of the script is that its output is
    // not — if this grows past a screenful per ticker it has stopped being a summary.
    const out = run();
    assert.ok(out.length < 20000, `summary is ${out.length} chars — too long to be a summary`);
  });
});

describe('a section added to the report must reach the summary', () => {
  /**
   * This has now happened twice. `breadth` and `tradability` were added to the
   * report and the summary printed neither — so the 05:30 agent would have seen a
   * tradability VETO in the JSON and never mentioned it.
   *
   * A section that runs and is never printed is indistinguishable from one that
   * never ran, which is the exact failure this script was written to prevent.
   */
  const src = readFileSync(`${process.cwd()}/scripts/morning-summary.js`, 'utf8');

  test('every top-level report section the writer emits is read by the summary', () => {
    const writer = readFileSync(`${process.cwd()}/scripts/morning-screen.js`, 'utf8');
    const block = writer.slice(writer.indexOf('const report = {'), writer.indexOf('const jsonPath'));
    // Top-level keys of the emitted report object.
    const emitted = [...block.matchAll(/^  ([a-z_]+):/gm)].map((m) => m[1]);
    // Bookkeeping and prose that a human summary has no reason to print.
    const NOT_SUMMARISED = new Set([
      'schema_version', 'generated_at', 'kind', 'universe', 'pipeline', 'tiers',
      'watchlist', 'cadence', 'batch_shared', 'tier_a_factors', 'not_advice',
      'completeness_summary', 'our_bias_summary', 'counts', 'screens', 'gate', 'tickers',
    ]);
    const missing = emitted.filter((k) => !NOT_SUMMARISED.has(k) && !src.includes(`r.${k}`));
    assert.deepEqual(missing, [],
      `the report emits ${missing.join(', ')} and morning-summary.js never reads it — the `
      + 'scheduled agent would not report it');
  });

  test('breadth and tradability are printed, including when unavailable', () => {
    // Unavailable must be LOUD. "Not checked" read as "all clear" is how an
    // unchecked run gets presented as a confirmed one.
    assert.match(src, /BREADTH/);
    assert.match(src, /TRADABILITY: NOT CHECKED/);
    assert.match(src, /Nothing was vetoed\. A failed scrape is not evidence/);
  });
});
