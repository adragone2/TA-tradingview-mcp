/**
 * CLI unit tests — no TradingView connection needed.
 * Tests: help output, pine analyze, pine check, error handling, exit codes.
 *
 * Run: node --test tests/cli.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, unlinkSync } from 'fs';

function require_fs() { return { writeFileSync, unlinkSync }; }

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'src', 'cli', 'index.js');

function run(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      timeout: 15000,
      ...opts,
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status,
    };
  }
}

describe('CLI — help and routing', () => {
  it('--help shows command list', () => {
    const { stdout, exitCode } = run(['--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('Usage: tv'));
    assert.ok(stdout.includes('status'));
    assert.ok(stdout.includes('pine'));
    assert.ok(stdout.includes('quote'));
  });

  it('-h is same as --help', () => {
    const { stdout, exitCode } = run(['-h']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('Usage: tv'));
  });

  it('no args shows help', () => {
    const { stdout, exitCode } = run([]);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('Usage: tv'));
  });

  it('unknown command exits 1', () => {
    const { exitCode, stderr } = run(['nonexistent']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('Unknown command'));
  });

  it('pine --help shows subcommands', () => {
    const { stdout, exitCode } = run(['pine', '--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('get'));
    assert.ok(stdout.includes('set'));
    assert.ok(stdout.includes('compile'));
    assert.ok(stdout.includes('analyze'));
    assert.ok(stdout.includes('check'));
  });

  it('ohlcv --help shows options', () => {
    const { stdout, exitCode } = run(['ohlcv', '--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('--count'));
    assert.ok(stdout.includes('--summary'));
  });
});

/**
 * `tv symbol info` used to be parsed as "set the symbol to INFO" — a real ETF
 * ticker — so it silently repointed the live chart and reported success. Every
 * verb that mutates the chart must now be typed explicitly, and anything the
 * parser does not recognise has to fail before it reaches the chart.
 *
 * These all assert on exit code 1 (a rejected argument), never 2 (a connection
 * failure) — the point is that the command dies during parsing, without ever
 * touching TradingView.
 */
describe('CLI — no bare argument may mutate the chart', () => {
  it('symbol rejects an unrecognised subcommand instead of setting it', () => {
    const { exitCode, stderr } = run(['symbol', 'nonsense']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('Unknown subcommand: symbol nonsense'), stderr);
  });

  it('symbol info routes to symbol_info, never to the set path', () => {
    // Asserted on routing rather than on a result, so this says the same thing
    // whether or not TradingView is running. `chart_ready` is emitted only by
    // setSymbol — seeing it here would mean "info" was taken for a ticker again.
    const { stdout, stderr } = run(['symbol', 'info']);
    assert.ok(!/Unknown subcommand/.test(stderr), stderr);
    assert.ok(!/chart_ready/.test(stdout + stderr), `symbol info took the set path: ${stdout}${stderr}`);
  });

  it('symbol set requires a ticker', () => {
    const { exitCode, stderr } = run(['symbol', 'set']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('Symbol required'), stderr);
  });

  it('symbol set takes exactly one ticker', () => {
    const { exitCode, stderr } = run(['symbol', 'set', 'CSCO', 'AAPL']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('Expected one symbol'), stderr);
  });

  it('symbol --help lists the subcommands and marks the default', () => {
    const { stdout, exitCode } = run(['symbol', '--help']);
    assert.equal(exitCode, 0);
    for (const sub of ['get', 'set', 'info', 'search']) assert.ok(stdout.includes(sub), stdout);
    assert.ok(/get\s+.*\(default\)/.test(stdout), stdout);
  });

  it('timeframe rejects an unrecognised subcommand', () => {
    const { exitCode, stderr } = run(['timeframe', '60']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('Unknown subcommand: timeframe 60'), stderr);
  });

  it('timeframe set rejects a value that is not a resolution', () => {
    const { exitCode, stderr } = run(['timeframe', 'set', 'get']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('Invalid timeframe'), stderr);
  });

  it('type rejects an unrecognised subcommand', () => {
    const { exitCode, stderr } = run(['type', 'Candles']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('Unknown subcommand: type Candles'), stderr);
  });

  it('ui scroll rejects an unknown direction rather than no-op scrolling', () => {
    const { exitCode, stderr } = run(['ui', 'scroll', 'upp']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('Unknown scroll direction'), stderr);
  });

  it('ui panel rejects a mistyped action instead of closing the panel', () => {
    const { exitCode, stderr } = run(['ui', 'panel', 'pine-editor', 'opne']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('Unknown panel action'), stderr);
  });

  it('ui panel rejects an unknown panel', () => {
    const { exitCode, stderr } = run(['ui', 'panel', 'watchlst', 'open']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('Unknown panel'), stderr);
  });

  it('draw remove requires an entity ID', () => {
    const { exitCode, stderr } = run(['draw', 'remove']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('Entity ID required'), stderr);
  });

  it('ui click requires a value to match', () => {
    const { exitCode, stderr } = run(['ui', 'click']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('--value is required'), stderr);
  });
});

describe('CLI — mistyped flags are not swallowed', () => {
  it('rejects an unknown flag on a top-level command', () => {
    const { exitCode, stderr } = run(['ohlcv', '--summry']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('Unknown option: --summry'), stderr);
  });

  it('rejects an unknown flag on a subcommand', () => {
    const { exitCode, stderr } = run(['draw', 'plan', '--targts', '110']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('Unknown option: --targts'), stderr);
  });

  it('still accepts negative numbers as option values', () => {
    // The reason parseArgs runs non-strict: `-5` is an error under strict
    // parsing, which would make `--price -5.5` unusable. The unknown-flag
    // check must not undo that. Read-only command on purpose — a test in the
    // unit suite must never reach for the live chart's drawings.
    const { stdout, stderr } = run(['ohlcv', '--count', '-5']);
    assert.ok(!/Unknown option/.test(stdout + stderr), `-5 was parsed as a flag: ${stdout}${stderr}`);
  });
});

describe('parseResolution — what counts as a timeframe', () => {
  it('accepts the resolutions TradingView actually uses', async () => {
    const { parseResolution } = await import('../src/core/chart.js');
    assert.equal(parseResolution('5'), '5');
    assert.equal(parseResolution('240'), '240');
    assert.equal(parseResolution('30S'), '30S');
    assert.equal(parseResolution('1D'), '1D');
    assert.equal(parseResolution('D'), 'D');
    assert.equal(parseResolution('d'), 'D');
    assert.equal(parseResolution(' W '), 'W');
    assert.equal(parseResolution('3W'), '3W');
    assert.equal(parseResolution('M'), 'M');
  });

  it('rejects anything else, including subcommand names', async () => {
    const { parseResolution } = await import('../src/core/chart.js');
    for (const bad of ['get', 'set', 'info', 'daily', '', null, undefined, '0', '0D', '1X', '1.5']) {
      assert.equal(parseResolution(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });
});

describe('CLI — pine analyze (offline)', () => {
  it('analyzes clean v6 script', () => {
    const source = '//@version=6\nindicator("test")\nplot(close)';
    const { stdout, exitCode } = run(['pine', 'analyze'], { input: source });
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.success, true);
    assert.equal(result.issue_count, 0);
  });

  it('detects array out of bounds', () => {
    const source = '//@version=6\nindicator("test")\narr = array.from(1, 2, 3)\nval = array.get(arr, 5)';
    const { stdout, exitCode } = run(['pine', 'analyze'], { input: source });
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.issue_count, 1);
    assert.ok(result.diagnostics[0].message.includes('out of bounds'));
  });

  it('detects strategy.entry without strategy()', () => {
    const source = '//@version=6\nindicator("test")\nstrategy.entry("long", strategy.long)';
    const { stdout, exitCode } = run(['pine', 'analyze'], { input: source });
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.ok(result.diagnostics.some(d => d.message.includes('strategy()')));
  });

  it('errors without input', () => {
    // When stdin is a TTY (no pipe), analyze should error
    const { exitCode, stderr } = run(['pine', 'analyze']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('No source provided'));
  });

  it('reads --file flag', () => {
    const { writeFileSync, unlinkSync } = require_fs();
    const tmpFile = join(__dirname, '_test_script.pine');
    writeFileSync(tmpFile, '//@version=6\nindicator("test")\nplot(close)');
    try {
      const { stdout, exitCode } = run(['pine', 'analyze', '--file', tmpFile]);
      assert.equal(exitCode, 0);
      const result = JSON.parse(stdout);
      assert.equal(result.success, true);
    } finally {
      unlinkSync(tmpFile);
    }
  });
});

describe('CLI — pine check (server compile)', () => {
  it('compiles valid Pine Script', () => {
    const source = '//@version=6\nindicator("test")\nplot(close)';
    const { stdout, exitCode } = run(['pine', 'check'], { input: source });
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.success, true);
    assert.equal(result.compiled, true);
  });

  it('returns errors for invalid Pine Script', () => {
    const source = '//@version=6\nindicator("test")\nplot(nonexistent_var)';
    const { stdout, exitCode } = run(['pine', 'check'], { input: source });
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.compiled, false);
    assert.ok(result.error_count > 0);
  });
});
