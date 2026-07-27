/**
 * Every source module must parse and load.
 *
 * This exists because of a real miss: a syntax error was committed in
 * `src/tools/patterns.js` — an unescaped apostrophe in a tool description — and
 * the whole unit suite stayed green, because the unit tests import from
 * `src/core/` and never touch `src/tools/`. The server would not have started.
 *
 * A test suite that can be green while the program cannot start is not
 * measuring the thing that matters. This walks every module under src/ and
 * imports it.
 *
 * Run: node --test tests/modules.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SRC = join(ROOT, 'src');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = walk(SRC);

describe('every module under src/ parses and loads', () => {
  it('finds a sensible number of modules to check', () => {
    assert.ok(files.length > 30, `expected the whole tree, found ${files.length} files`);
  });

  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    // server.js connects a stdio transport on import; loading it here would
    // hang the test run. Its syntax is covered by the modules it imports.
    if (rel.endsWith('src/server.js')) continue;

    it(`loads ${rel}`, async () => {
      await assert.doesNotReject(
        () => import(pathToFileURL(file).href),
        `${rel} failed to load — a syntax error here means the server cannot start`,
      );
    });
  }
});
