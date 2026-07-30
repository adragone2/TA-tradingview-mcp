/**
 * Tracks which chart drawings this tool created.
 *
 * `draw_clear` used to call removeAllShapes(), which also destroyed drawings
 * the user had placed by hand. The registry makes "clear only what you drew"
 * possible, and lets related drawings (a trade plan's entry/stop/targets) be
 * cleared as one group.
 *
 * Persisted to disk rather than kept in memory because the CLI is a fresh
 * process per invocation — an in-memory set would be empty by the time the
 * user ran `tv draw clear`.
 *
 * TradingView entity IDs are session-scoped, so the store is expected to
 * accumulate stale IDs. Callers reconcile against the live shape list and
 * prune; a stale ID is never an error.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const STORE_DIR = join(homedir(), ".tradingview-mcp");
const STORE_PATH = join(STORE_DIR, "drawings.json");

// Bound the store so a long-running session can't grow it without limit.
const MAX_ENTRIES = 2000;
// Symbols are a few bytes each and are the only record of WHERE to look, so
// they get their own, much larger bound.
const MAX_SYMBOLS = 5000;

function readStore(path = STORE_PATH) {
  if (!existsSync(path)) return { entries: [], symbols: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed?.entries)) return { entries: [], symbols: [] };
    return { entries: parsed.entries, symbols: Array.isArray(parsed.symbols) ? parsed.symbols : [] };
  } catch {
    // A corrupt store must never block drawing. Start over.
    return { entries: [], symbols: [] };
  }
}

function writeStore(store, path = STORE_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const entries = store.entries.slice(-MAX_ENTRIES);
  // `symbols` is deliberately NOT derived from `entries` — see recordSymbol.
  const symbols = (store.symbols || []).slice(-MAX_SYMBOLS);
  writeFileSync(path, JSON.stringify({ entries, symbols }, null, 2));
}

/**
 * Record drawings this tool created.
 * @param {Array<{entity_id: string, shape?: string, role?: string}>} items
 * @param {{group?: string, symbol?: string, path?: string}} meta
 */
export function record(items, { group = null, symbol = null, path = STORE_PATH } = {}) {
  const valid = (items || []).filter((i) => i && i.entity_id);
  if (!valid.length) return { recorded: 0, group };

  const store = readStore(path);
  if (symbol && !(store.symbols || []).includes(symbol)) {
    store.symbols = [...(store.symbols || []), symbol];
  }
  const created_at = new Date().toISOString();
  for (const item of valid) {
    store.entries.push({
      entity_id: item.entity_id,
      shape: item.shape || null,
      role: item.role || null,
      group,
      symbol,
      created_at,
    });
  }
  writeStore(store, path);
  return { recorded: valid.length, group };
}

/** All tracked entries, newest last. Optionally filtered by group. */
export function list({ group = null, path = STORE_PATH } = {}) {
  const { entries } = readStore(path);
  return group ? entries.filter((e) => e.group === group) : entries;
}

/**
 * Every symbol this tool has ever drawn on.
 *
 * APPEND-ONLY, and separate from `entries` on purpose. Entity IDs die with the
 * TradingView session, so `prune` and `forget` legitimately empty `entries` —
 * and when they do, the record of WHERE drawings were made goes with them.
 * A cleanup sweep then has no way to find those charts: CARG kept 17 shapes
 * through a full sweep because it had dropped off TA's actionable list and the
 * registry no longer remembered it.
 *
 * A symbol name costs a few bytes and never goes stale, so it is kept even
 * after every drawing on that chart is gone. Being sent to look at a clean
 * chart is free; not knowing to look at all is not recoverable.
 */
export function drawnSymbols({ path = STORE_PATH } = {}) {
  return [...new Set(readStore(path).symbols || [])];
}

/** Distinct group names currently tracked. */
export function groups({ path = STORE_PATH } = {}) {
  const seen = new Map();
  for (const e of list({ path })) {
    if (!e.group) continue;
    const g = seen.get(e.group) || { group: e.group, count: 0, symbol: e.symbol, created_at: e.created_at };
    g.count += 1;
    seen.set(e.group, g);
  }
  return [...seen.values()];
}

/** Drop specific entity IDs from the store. */
export function forget(entityIds, { path = STORE_PATH } = {}) {
  const drop = new Set(entityIds || []);
  if (!drop.size) return { forgotten: 0 };
  const store = readStore(path);
  const before = store.entries.length;
  store.entries = store.entries.filter((e) => !drop.has(e.entity_id));
  writeStore(store, path);
  return { forgotten: before - store.entries.length };
}

/**
 * Drop tracked IDs that no longer exist on the chart.
 * @param {string[]} liveIds ids currently returned by getAllShapes()
 */
/**
 * Drop entries whose shapes no longer exist on the chart.
 *
 * **`symbol` is not optional in practice.** `getAllShapes()` returns only the
 * shapes on the CURRENTLY LOADED symbol, so pruning globally against that list
 * deletes the registry entries for every other symbol — they are simply not in
 * the live list. In a multi-symbol run that silently untracks everything drawn
 * on every previous symbol, and the next `clearAll` for those groups then finds
 * nothing to remove and the drawings accumulate forever.
 *
 * Found the hard way: a weekly review run four times left 61 shapes on CARG
 * with support levels stacked 4-6 deep.
 *
 * So: pass the symbol whose shapes `liveIds` came from, and only that symbol's
 * entries are considered. Entries for other symbols are left alone.
 */
export function prune(liveIds, { symbol = null, path = STORE_PATH } = {}) {
  const store = readStore(path);
  const before = store.entries.length;

  /**
   * NO SYMBOL, NO PRUNE. Unknown is not "safe to delete".
   *
   * `liveIds` comes from `getAllShapes()`, which only ever sees the CURRENT chart.
   * Without knowing which symbol produced them, every entry for every OTHER symbol
   * looks non-live and the whole store gets emptied in one call.
   *
   * That is not hypothetical — it happened. `currentSymbol()` swallows any failure
   * and returns null, the old guard was `if (symbol && ...)`, so a single null
   * reading untracked every drawing on every chart. The shapes stayed on the charts
   * and became permanently unclearable by `scope: "mcp"`: 13 charts measured
   * afterwards read `created_by_mcp: false` for drawings this toolchain had made
   * minutes earlier.
   *
   * Refusing is strictly safer. The cost of not pruning is a stale entry, which the
   * next scoped prune removes. The cost of over-pruning is a drawing that can never
   * be cleaned up again — the exact leak `clear-orphans.js` exists to mop up.
   */
  if (!symbol) {
    return {
      pruned: 0,
      remaining: before,
      scoped_to: null,
      refused: true,
      why: 'prune needs the symbol these liveIds came from. getAllShapes() only sees the current '
        + 'chart, so an unscoped prune would untrack every OTHER symbol\'s drawings and leave them '
        + 'on the charts with no way to clear them.',
    };
  }

  store.entries = store.entries.filter((e) => {
    // Only judge entries belonging to the symbol these ids came from.
    if (e.symbol && e.symbol !== symbol) return true;
    if (!e.symbol) return true;             // untagged legacy entries: leave alone
    return live(liveIds).has(e.entity_id);
  });
  writeStore(store, path);
  return { pruned: before - store.entries.length, remaining: store.entries.length, scoped_to: symbol };
}

/** Memoised per call — `filter` would otherwise rebuild the Set per entry. */
let _liveCache = { src: null, set: null };
function live(liveIds) {
  if (_liveCache.src !== liveIds) _liveCache = { src: liveIds, set: new Set(liveIds || []) };
  return _liveCache.set;
}

export function clear({ path = STORE_PATH } = {}) {
  writeStore({ entries: [] }, path);
  return { cleared: true };
}

export const STORE_LOCATION = STORE_PATH;
