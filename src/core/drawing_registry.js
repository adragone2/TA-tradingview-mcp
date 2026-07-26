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

function readStore(path = STORE_PATH) {
  if (!existsSync(path)) return { entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed?.entries) ? parsed : { entries: [] };
  } catch {
    // A corrupt store must never block drawing. Start over.
    return { entries: [] };
  }
}

function writeStore(store, path = STORE_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const entries = store.entries.slice(-MAX_ENTRIES);
  writeFileSync(path, JSON.stringify({ entries }, null, 2));
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
export function prune(liveIds, { path = STORE_PATH } = {}) {
  const live = new Set(liveIds || []);
  const store = readStore(path);
  const before = store.entries.length;
  store.entries = store.entries.filter((e) => live.has(e.entity_id));
  writeStore(store, path);
  return { pruned: before - store.entries.length, remaining: store.entries.length };
}

export function clear({ path = STORE_PATH } = {}) {
  writeStore({ entries: [] }, path);
  return { cleared: true };
}

export const STORE_LOCATION = STORE_PATH;
