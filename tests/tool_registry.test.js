import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  staleness, sourceTools, recordRegistrations, registeredTools, newestSourceMtime,
} from '../src/core/tool_registry.js';

const src = (names) => ({ names: [...names].sort(), readable: true, dir: '/fake/tools' });

describe('staleness — is the running server the code on disk?', () => {
  test('a tool in source but NOT registered fails, and is NAMED', () => {
    /**
     * The exact case that cost an hour: two tools written, registered, tested and
     * committed, and calling one returned "No such tool available". The process
     * predated them. The check has to name them, because the confusing part is
     * that OTHER tools from the same file work fine.
     */
    const r = staleness({
      live: ['ticker_playbook', 'group_context'],
      source: src(['ticker_playbook', 'group_context', 'chart_indicators_for_strategy', 'position_size_constrained']),
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing_tools, ['chart_indicators_for_strategy', 'position_size_constrained']);
    assert.match(r.detail, /STALE/);
    assert.match(r.detail, /same file/, 'must explain why a sibling tool still working is not a contradiction');
    assert.match(r.fix, /[Rr]estart/);
  });

  test('a matching list passes', () => {
    const names = ['a', 'b', 'c'];
    const r = staleness({ live: names, source: src(names) });
    assert.equal(r.ok, true);
    assert.equal(r.registered_count, 3);
  });

  test('a registration with no source file is noted but does NOT fail', () => {
    // Tools registered outside src/tools/ are legitimate; only the reverse is a bug.
    const r = staleness({ live: ['a', 'b', 'elsewhere'], source: src(['a', 'b']) });
    assert.equal(r.ok, true);
    assert.deepEqual(r.extra_tools, undefined, 'extra_tools only appears on the failing branch');
  });

  test('extra tools are reported alongside a real staleness failure', () => {
    const r = staleness({ live: ['a', 'elsewhere'], source: src(['a', 'b']) });
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing_tools, ['b']);
    assert.deepEqual(r.extra_tools, ['elsewhere']);
  });

  test('source newer than the process is ADVICE, not a failure', () => {
    /**
     * The tool list matching proves the names are current; it proves nothing about
     * behaviour. Saying so is the point — a green check that cannot see behaviour
     * edits would give false confidence.
     */
    const names = ['a'];
    const r = staleness({
      live: names, source: src(names),
      startedMs: 1_000_000, newestMs: 1_600_000, newestFile: '/repo/src/core/chart.js',
      relativeTo: '/repo/src',
    });
    assert.equal(r.ok, true, 'a touched file must not fail the check');
    assert.equal(r.source_newer_than_process, true);
    assert.equal(r.minutes_newer, 10);
    assert.equal(r.newest_source_file, path.join('core', 'chart.js'));
    assert.match(r.detail, /cannot tell whether the loaded behaviour does/);
    assert.match(r.advice, /blind to an edit/);
  });

  test('source older than the process reports no staleness at all', () => {
    const names = ['a'];
    const r = staleness({
      live: names, source: src(names), startedMs: 2_000_000, newestMs: 1_000_000,
    });
    assert.equal(r.source_newer_than_process, false);
    assert.equal(r.advice, undefined);
  });

  test('no recorded registrations abstains instead of claiming everything is missing', () => {
    // Otherwise the check screams STALE at any consumer that never installed the recorder.
    const r = staleness({ live: [], source: src(['a', 'b']) });
    assert.equal(r.ok, true);
    assert.match(r.detail, /recordRegistrations\(\) was not installed/);
  });

  test('an unreadable source directory abstains rather than guessing', () => {
    const r = staleness({ live: ['a'], source: { names: [], readable: false, dir: '/nope' } });
    assert.equal(r.ok, true);
    assert.match(r.detail, /Could not read/);
  });
});

describe('sourceTools — scanning registrations out of the files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscan-'));

  test('finds names across both registration styles, and skips _private files', () => {
    fs.writeFileSync(path.join(tmp, 'a.js'), [
      "server.tool(",
      "  'multi_line_tool',",
      "  'desc',",
      ");",
      "server.tool('one_line_tool', 'desc', {}, fn);",
    ].join('\n'));
    // Helper modules are not tool modules.
    fs.writeFileSync(path.join(tmp, '_format.js'), "server.tool('should_not_be_found', 'x');");
    fs.writeFileSync(path.join(tmp, 'notjs.txt'), "server.tool('also_not_found', 'x');");

    const r = sourceTools({ dir: tmp });
    assert.equal(r.readable, true);
    assert.deepEqual(r.names, ['multi_line_tool', 'one_line_tool']);
  });

  test('a missing directory is readable:false, not a throw', () => {
    const r = sourceTools({ dir: path.join(tmp, 'does-not-exist') });
    assert.equal(r.readable, false);
    assert.deepEqual(r.names, []);
  });
});

describe('recordRegistrations — the live half', () => {
  test('records every name and still registers the tool', () => {
    const seen = [];
    const fakeServer = { tool: (name, desc) => { seen.push([name, desc]); return 'registered'; } };
    recordRegistrations(fakeServer);

    const out = fakeServer.tool('brand_new_tool', 'a description', {}, () => {});
    assert.equal(out, 'registered', 'the original registration must still happen');
    assert.deepEqual(seen, [['brand_new_tool', 'a description']]);
    assert.ok(registeredTools().includes('brand_new_tool'));
  });
});

describe('newestSourceMtime — against the real tree', () => {
  test('finds a real .js file with a real mtime', () => {
    const { newest_ms: ms, file } = newestSourceMtime();
    assert.ok(ms > 0, 'src/ must contain at least one readable .js file');
    assert.match(file, /\.js$/);
  });
});
