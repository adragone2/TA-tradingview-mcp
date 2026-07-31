/**
 * The counts in CLAUDE.md must be the counts in the code.
 *
 * CLAUDE.md is loaded into EVERY session, which makes a wrong number there worse
 * than a wrong number anywhere else: nothing reads it critically, nothing checks
 * it against the source, and it is quietly believed for months. "184 MCP tools"
 * was believed while there were 187; "18 strategies" while strategies.json held
 * 20; "8 swing screens + 1 intraday" while screens.js exported two intraday
 * screens. Three separate drifts, none of them noticed by a test, all three
 * found by hand.
 *
 * They drift for a structural reason. Adding a tool means editing src/tools/*.js;
 * adding a strategy means editing strategies.json; adding a screen means editing
 * src/core/screens.js. None of those edits has any reason to touch CLAUDE.md, so
 * the index goes stale exactly when the repo is growing fastest.
 *
 * So the counts are DERIVED here, at test time, from the same sources the code
 * uses, and asserted against the text. The regexes are anchored to the words
 * around each number so a failure names WHICH count drifted rather than saying a
 * file did not match.
 *
 * Both imports are pure at module load. `tool_registry.js` reads the filesystem
 * (fs/path/url only); `screens.js` imports `scanner.js`, which declares constants
 * and functions at the top level and only touches the network inside a call. If
 * either ever gains a side effect at import, parse the file text instead — this
 * test must never open a socket.
 *
 * Run: node --test tests/doc_counts.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sourceTools } from '../src/core/tool_registry.js';
import { SCREENS, INTRADAY_SCREENS } from '../src/core/screens.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// ── The derivations ──────────────────────────────────────────────────────────
// Each of these is the SAME source the running code reads, not a second copy of
// the number. A count that is maintained in two places is the bug being guarded.

/** Tools declared in src/tools/*.js — what tv_doctor diffs the live server against. */
const TOOL_COUNT = sourceTools().names.length;

/** strategies.json is the catalogue of record; rules.json still wins a name clash. */
const catalogue = JSON.parse(read('strategies.json')).strategies;
const STRATEGY_KEYS = Object.keys(catalogue);
const STRATEGY_COUNT = STRATEGY_KEYS.length;
const REJECTED_COUNT = STRATEGY_KEYS
  .filter((k) => catalogue[k].evidence_tier === 'REJECTED').length;

/** Two exports, deliberately separate: SCREENS feed the swing merge, INTRADAY_SCREENS do not. */
const SWING_SCREEN_COUNT = SCREENS.length;
const INTRADAY_SCREEN_COUNT = INTRADAY_SCREENS.length;

/**
 * Pull the number out of a phrase, so the failure message can say what the doc
 * claims and what the code says. A missing phrase is its own failure: it means
 * the sentence was reworded and the guard silently stopped guarding anything.
 */
function claimed(text, re, what, file) {
  const m = text.match(re);
  assert.ok(m, `${file}: could not find the ${what} claim (pattern ${re}). `
    + 'If the wording changed, update the regex here — a guard that matches nothing '
    + 'passes forever.');
  return Number(m[1]);
}

function assertCount(text, re, expected, what, file) {
  const found = claimed(text, re, what, file);
  assert.equal(found, expected,
    `${file} says ${found} ${what}; the code has ${expected}. Fix the doc.`);
}

describe('CLAUDE.md counts match the code', () => {
  const claudeMd = read('CLAUDE.md');

  it('the header line states the real tool count', () => {
    // "187 MCP tools driving a live TradingView Desktop chart over CDP..."
    assertCount(claudeMd, /(\d+) MCP tools driving a live TradingView/,
      TOOL_COUNT, 'MCP tools', 'CLAUDE.md');
  });

  it('the tools-reference row states the real tool count', () => {
    // "| docs/tools-reference.md | All 187 tools (generated ...) |"
    assertCount(claudeMd, /tools-reference\.md\)\s*\|\s*All (\d+) tools/,
      TOOL_COUNT, 'tools in the tools-reference row', 'CLAUDE.md');
  });

  it('the strategies row states the real strategy count', () => {
    // "| docs/strategies.md | **THE strategy catalogue** — 20 strategies by execution tier ..."
    assertCount(claudeMd, /strategy catalogue\*\* — (\d+) strategies by execution tier/,
      STRATEGY_COUNT, 'strategies in the strategies row', 'CLAUDE.md');
    assertCount(claudeMd, /monthly 11d\+\), (\d+) of them kept as REJECTED/,
      REJECTED_COUNT, 'REJECTED strategies in the strategies row', 'CLAUDE.md');
  });

  it('the screening row states the real screen counts', () => {
    // "**8 swing screens + 2 intraday**, one per strategy family"
    assertCount(claudeMd, /\*\*(\d+) swing screens \+ \d+ intraday\*\*/,
      SWING_SCREEN_COUNT, 'swing screens', 'CLAUDE.md');
    assertCount(claudeMd, /\*\*\d+ swing screens \+ (\d+) intraday\*\*/,
      INTRADAY_SCREEN_COUNT, 'intraday screens', 'CLAUDE.md');
  });

  it('the strategies-as-data rule states the real strategy count', () => {
    // The body paragraph drifted independently of the table row above it, which is
    // why both are asserted: one number, two places, and only one of them was fixed.
    assertCount(claudeMd, /(\d+) strategies are catalogued as DATA/,
      STRATEGY_COUNT, 'catalogued strategies', 'CLAUDE.md');
  });

  it('the strategies-as-data rule counts the REJECTED entries in words', () => {
    // Spelled out in the prose ("Seven entries are tiered REJECTED"), so the
    // numeral regexes above cannot catch it. It was stale at six.
    const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
      'eight', 'nine', 'ten', 'eleven', 'twelve'];
    const m = claudeMd.match(/\*\*([A-Za-z]+) entries are tiered REJECTED/);
    assert.ok(m, 'CLAUDE.md: could not find the "N entries are tiered REJECTED" claim.');
    assert.equal(m[1].toLowerCase(), WORDS[REJECTED_COUNT],
      `CLAUDE.md says "${m[1]} entries are tiered REJECTED"; strategies.json has `
      + `${REJECTED_COUNT} (${WORDS[REJECTED_COUNT]}).`);
  });
});

describe('the other always-loaded surfaces carry the same counts', () => {
  it('docs/START-HERE.md states the real tool count', () => {
    // The entry point CLAUDE.md sends every session to on its first line.
    const startHere = read('docs/START-HERE.md');
    assertCount(startHere, /\| (\d+) tools driving a live TradingView Desktop chart/,
      TOOL_COUNT, 'tools in the layers table', 'docs/START-HERE.md');
    assertCount(startHere, /tools-reference\.md\) — all (\d+) tools by group/,
      TOOL_COUNT, 'tools in the doc index', 'docs/START-HERE.md');
  });

  it('the MCP server instructions state the real tool count', () => {
    // src/server.js's `instructions` block is loaded into every session by the MCP
    // client, the same as CLAUDE.md, and drifted the same way.
    assertCount(read('src/server.js'), /TradingView MCP — (\d+) tools\./,
      TOOL_COUNT, 'tools in the server instructions', 'src/server.js');
  });
});

describe('docs/screening.md agrees with itself about the schedule', () => {
  // The header said "07:00 ET" while the table four lines below said 05:30 PT —
  // the same file contradicting itself. The run is 05:30 PT / 08:30 ET, and the
  // whole pipeline is built around being an hour ahead of the 06:30 PT open.
  const screening = read('docs/screening.md');

  it('states 05:30 PT', () => {
    assert.ok(screening.includes('05:30 PT'),
      'docs/screening.md no longer states the 05:30 PT schedule.');
  });

  it('does not state the stale 07:00 ET', () => {
    assert.ok(!screening.includes('07:00 ET'),
      'docs/screening.md still says 07:00 ET. The morning screen runs 05:30 PT (08:30 ET).');
  });
});
