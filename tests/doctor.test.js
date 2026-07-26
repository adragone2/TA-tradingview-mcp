/**
 * Doctor + rules unit tests — no TradingView connection needed.
 * These must pass on a machine where TradingView is not installed and
 * port 9222 is dead, since that is exactly the state doctor exists to report.
 *
 * Run: node --test tests/doctor.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { doctor } from '../src/core/doctor.js';
import { initRules, rulesStatus, resolveRules, DEFAULT_RULES } from '../src/core/rules.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'src', 'cli', 'index.js');

function runCli(args) {
  try {
    return { stdout: execFileSync('node', [CLI, ...args], { encoding: 'utf-8', timeout: 30000 }), exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status };
  }
}

/**
 * Resolution is pointed at a temp directory rather than the repo, so these
 * tests never read, move, or delete a developer's real rules.json.
 */
function emptyRoots() {
  const dir = mkdtempSync(join(tmpdir(), 'tvmcp-roots-'));
  return { roots: [join(dir, 'rules.json')], cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('rules — resolution', () => {
  it('falls back to defaults instead of throwing when no rules.json exists', () => {
    const { roots, cleanup } = emptyRoots();
    try {
      const r = resolveRules(undefined, { roots });
      assert.equal(r.using_defaults, true);
      assert.equal(r.source, 'defaults');
      assert.equal(r.path, null);
      assert.ok(r.warning.includes('tv rules init'));
      assert.deepEqual(r.rules.bias_criteria, DEFAULT_RULES.bias_criteria);
    } finally {
      cleanup();
    }
  });

  it('default watchlist is empty so the live watchlist is used', () => {
    const { roots, cleanup } = emptyRoots();
    try {
      assert.deepEqual(resolveRules(undefined, { roots }).rules.watchlist, []);
    } finally {
      cleanup();
    }
  });

  it('prefers a rules.json found on the search path over defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tvmcp-roots-'));
    const onPath = join(dir, 'rules.json');
    writeFileSync(onPath, JSON.stringify({ watchlist: ['ONPATH'] }));
    try {
      const r = resolveRules(undefined, { roots: [onPath] });
      assert.equal(r.using_defaults, false);
      assert.equal(r.path, onPath);
      assert.deepEqual(r.rules.watchlist, ['ONPATH']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on an explicit --rules path that does not exist', () => {
    assert.throws(() => resolveRules('/nope/does-not-exist.json'), /No rules file at/);
  });

  it('does not silently fall back to another rules.json when --rules is wrong', () => {
    // Regression: a bad explicit path used to fall through to the project
    // rules.json, silently scanning a watchlist the user never asked for.
    const dir = mkdtempSync(join(tmpdir(), 'tvmcp-roots-'));
    const decoy = join(dir, 'rules.json');
    writeFileSync(decoy, JSON.stringify({ watchlist: ['DECOY'] }));
    try {
      assert.throws(
        () => resolveRules(join(dir, 'typo.json'), { roots: [decoy] }),
        /No rules file at/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws a fixable message on malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tvmcp-'));
    const bad = join(dir, 'rules.json');
    writeFileSync(bad, '{ not json');
    try {
      assert.throws(() => resolveRules(bad), /not valid JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a real rules.json when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tvmcp-'));
    const good = join(dir, 'rules.json');
    writeFileSync(good, JSON.stringify({ watchlist: ['BTCUSD'], default_timeframe: '60' }));
    try {
      const r = resolveRules(good);
      assert.equal(r.using_defaults, false);
      assert.equal(r.source, 'file');
      assert.deepEqual(r.rules.watchlist, ['BTCUSD']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rules — init', () => {
  it('creates rules.json from the template', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tvmcp-'));
    const target = join(dir, 'rules.json');
    try {
      const res = initRules({ path: target });
      assert.equal(res.created, true);
      assert.ok(existsSync(target));
      const parsed = JSON.parse(readFileSync(target));
      assert.ok(Array.isArray(parsed.watchlist));
      assert.ok(parsed.bias_criteria);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to clobber an existing file without force', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tvmcp-'));
    const target = join(dir, 'rules.json');
    writeFileSync(target, '{"watchlist":["MINE"]}');
    try {
      const res = initRules({ path: target });
      assert.equal(res.created, false);
      assert.deepEqual(JSON.parse(readFileSync(target)).watchlist, ['MINE']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('overwrites when force is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tvmcp-'));
    const target = join(dir, 'rules.json');
    writeFileSync(target, '{"watchlist":["MINE"]}');
    try {
      const res = initRules({ path: target, force: true });
      assert.equal(res.created, true);
      assert.notDeepEqual(JSON.parse(readFileSync(target)).watchlist, ['MINE']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rulesStatus reports absence without throwing', () => {
    const { roots, cleanup } = emptyRoots();
    try {
      const s = rulesStatus({ roots });
      assert.equal(s.found, false);
      assert.ok(s.hint.includes('tv rules init'));
      assert.ok(s.searched.length >= 1);
    } finally {
      cleanup();
    }
  });

  it('rulesStatus reports the real search path without modifying anything', () => {
    const s = rulesStatus();
    assert.equal(s.success, true);
    assert.ok(s.searched.some((p) => p.endsWith('rules.json')));
  });
});

describe('doctor — offline behaviour', () => {
  it('returns structured checks and never throws when nothing is running', async () => {
    const res = await doctor({ port: 59999, skip_server_test: true });
    assert.equal(res.success, true);
    assert.ok(Array.isArray(res.checks));
    const names = res.checks.map((c) => c.name);
    assert.ok(names.includes('node_version'));
    assert.ok(names.includes('cdp_port'));
    assert.ok(names.includes('rules_json'));
  });

  it('reports a dead CDP port as failed with an actionable fix', async () => {
    const res = await doctor({ port: 59999, skip_server_test: true });
    const cdp = res.checks.find((c) => c.name === 'cdp_port');
    assert.equal(cdp.ok, false);
    assert.ok(cdp.fix, 'failing check must carry a fix');
    assert.ok(/remote-debugging-port|launch/.test(cdp.fix));
    assert.equal(res.ok, false);
    assert.ok(res.next);
  });

  it('skips chart and live-read checks when the port is dead', async () => {
    const names = (await doctor({ port: 59999, skip_server_test: true })).checks.map((c) => c.name);
    assert.ok(!names.includes('chart_target'));
    assert.ok(!names.includes('live_read'));
  });

  it('treats rules.json as advisory, never a failure, either way', async () => {
    const res = await doctor({ port: 59999, skip_server_test: true });
    const rules = res.checks.find((c) => c.name === 'rules_json');
    assert.equal(rules.ok, true, 'rules.json must never fail the run');
    // Advice appears only when the file is absent; presence is the other branch.
    if (rules.advice) assert.ok(rules.advice.includes('tv rules init'));
    assert.ok(rules.detail);
  });

  it('node_version check passes on the running interpreter', async () => {
    const res = await doctor({ port: 59999, skip_server_test: true });
    assert.equal(res.checks.find((c) => c.name === 'node_version').ok, true);
  });

  it('smoke-tests that the MCP server actually loads', async () => {
    const res = await doctor({ port: 59999 });
    const server = res.checks.find((c) => c.name === 'mcp_server_loads');
    assert.equal(server.ok, true, `server failed to load: ${server.detail}`);
  });
});

describe('doctor — CLI wiring', () => {
  it('tv doctor emits JSON', () => {
    const { stdout, exitCode } = runCli(['doctor', '--port', '59999', '--skip-server-test']);
    assert.equal(exitCode, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.success, true);
    assert.ok(parsed.checks.length > 0);
  });

  it('tv doctor is listed in help', () => {
    const { stdout } = runCli(['--help']);
    assert.ok(stdout.includes('doctor'));
    assert.ok(stdout.includes('rules'));
  });

  it('tv rules path reports status', () => {
    const { stdout, exitCode } = runCli(['rules', 'path']);
    assert.equal(exitCode, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.success, true);
    assert.ok(Array.isArray(parsed.searched));
    assert.equal(typeof parsed.found, 'boolean');
  });
});
