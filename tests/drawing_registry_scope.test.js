import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as registry from '../src/core/drawing_registry.js';

/**
 * The registry must never lose track of a drawing that is still on a chart.
 *
 * Losing one is not a cosmetic bug. `draw_clear scope:"mcp"` only removes what the
 * registry knows about, so an untracked drawing stays on the chart and can never be
 * cleared by scope again — it can only be swept by `clear-orphans.js` matching its
 * TEXT, and only if its label happens to match a registered signature.
 *
 * Both defects below were found on the live chart within minutes of each other,
 * after a morning run that drew on 26 charts.
 */

let PATH;
beforeEach(() => {
  const d = join(tmpdir(), `reg-${process.pid}-${Math.floor(process.hrtime()[1])}`);
  mkdirSync(d, { recursive: true });
  PATH = join(d, 'drawings.json');
});

const seed = (entries) => writeFileSync(PATH, JSON.stringify({ entries, symbols: [] }), 'utf8');
const read = () => JSON.parse(readFileSync(PATH, 'utf8')).entries;

describe('prune is scoped to one symbol', () => {
  test('it never touches another symbol', () => {
    seed([
      { entity_id: 'a1', symbol: 'BATS:AAA' },
      { entity_id: 'b1', symbol: 'BATS:BBB' },
      { entity_id: 'b2', symbol: 'BATS:BBB' },
    ]);
    // On AAA's chart, only a1 is live. BBB's entries are invisible to getAllShapes().
    const r = registry.prune(['a1'], { symbol: 'BATS:AAA', path: PATH });
    assert.equal(r.pruned, 0);
    assert.deepEqual(read().map((e) => e.entity_id).sort(), ['a1', 'b1', 'b2']);
  });

  test('it does drop this symbol\'s dead entries', () => {
    seed([{ entity_id: 'a1', symbol: 'BATS:AAA' }, { entity_id: 'a2', symbol: 'BATS:AAA' }]);
    registry.prune(['a1'], { symbol: 'BATS:AAA', path: PATH });
    assert.deepEqual(read().map((e) => e.entity_id), ['a1']);
  });

  test('NO SYMBOL means prune NOTHING, and says so', () => {
    /**
     * `currentSymbol()` swallows any failure and returns null. The old guard was
     * `if (symbol && ...)`, so one null reading made every entry for every other
     * symbol look non-live and emptied the whole store in a single call.
     *
     * Unknown is not "safe to delete" — the same principle as `evalClause` returning
     * `pass: null` for a missing column, and as the liquidity constraint reporting
     * NOT CHECKED rather than satisfied.
     */
    seed([{ entity_id: 'a1', symbol: 'BATS:AAA' }, { entity_id: 'b1', symbol: 'BATS:BBB' }]);
    const r = registry.prune(['a1'], { symbol: null, path: PATH });
    assert.equal(r.pruned, 0);
    assert.equal(r.refused, true);
    assert.match(r.why, /needs the symbol/);
    assert.equal(read().length, 2, 'an unscoped prune must be a no-op, not a wipe');
  });

  test('untagged legacy entries are left alone', () => {
    seed([{ entity_id: 'old' }, { entity_id: 'a1', symbol: 'BATS:AAA' }]);
    registry.prune(['a1'], { symbol: 'BATS:AAA', path: PATH });
    assert.equal(read().length, 2);
  });
});

describe('forget is bounded to what was actually cleared', () => {
  test('the source contract: clearAll forgets ids, never candidates', () => {
    /**
     * `candidates` is `registry.list({group})` — with no group that is EVERY entry
     * for every symbol, while `ids` is only those live on the chart in front of us.
     * Forgetting candidates meant one `draw_clear scope:"mcp"` deleted 22 shapes on
     * the loaded symbol and orphaned every drawing on every OTHER chart.
     *
     * Measured immediately after: FTAI still carried its 8 shapes, every one reading
     * `created_by_mcp: false`, minutes after this toolchain drew them.
     */
    const src = readFileSync(`${process.cwd()}/src/core/drawing.js`, 'utf8');
    assert.match(src, /registry\.forget\(ids\)/,
      'forget must be bounded by the ids live on this chart');
    assert.ok(!/registry\.forget\(candidates\.map/.test(src),
      'forgetting every candidate untracks every other symbol');
  });

  test('forget removes exactly the ids given', () => {
    seed([{ entity_id: 'a1', symbol: 'A' }, { entity_id: 'a2', symbol: 'A' }, { entity_id: 'b1', symbol: 'B' }]);
    registry.forget(['a1'], { path: PATH });
    assert.deepEqual(read().map((e) => e.entity_id).sort(), ['a2', 'b1']);
  });
});
