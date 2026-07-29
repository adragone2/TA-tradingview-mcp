#!/usr/bin/env node
/**
 * Run the test suite.
 *
 * This exists because the npm scripts used to hand-list every test file — twice,
 * in `test:unit` and `test:all`. Adding a test file and forgetting to add it to
 * both lists meant the tests never ran and nothing said so. Two files had
 * already fallen off that way.
 *
 * Discovery is by directory scan, so a new tests/*.test.js is picked up with no
 * further action. Anything needing a live TradingView chart lives in LIVE_ONLY
 * and is skipped unless you ask for it, because a suite that hangs waiting for
 * a socket is a suite nobody runs.
 *
 *   node scripts/run-tests.js            unit suite
 *   node scripts/run-tests.js --live     unit suite plus the live-chart tests
 *   node scripts/run-tests.js --only x   only files matching "x"
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests');

/** Needs a live chart on CDP 9222. Excluded by default. */
const LIVE_ONLY = new Set(['e2e.test.js']);

const args = process.argv.slice(2);
const withLive = args.includes('--live');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

let files = readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => withLive || !LIVE_ONLY.has(f))
  .filter((f) => !only || f.includes(only))
  .sort();

if (!files.length) {
  console.error(only ? `No test files match "${only}".` : 'No test files found.');
  process.exit(1);
}

const skipped = readdirSync(TESTS_DIR).filter((f) => f.endsWith('.test.js')).length - files.length;
console.log(`Running ${files.length} test file(s)${skipped ? `, skipping ${skipped}` : ''}.`);
if (!withLive && LIVE_ONLY.size) console.log(`  (live-chart tests need --live: ${[...LIVE_ONLY].join(', ')})`);

const res = spawnSync(
  process.execPath,
  ['--test', ...files.map((f) => join(TESTS_DIR, f))],
  { stdio: 'inherit' },
);
process.exit(res.status ?? 1);
