/**
 * Rewrite ONE named TradingView watchlist from scratch.
 *
 * ── Why this is not applySync ──
 *
 * `watchlist_sync.js` already writes to TradingView, and its safety rule is
 * "never shrink":
 *
 *     Refusing to write: rebuilding the watchlist would drop N existing symbols
 *     Refusing to write: rebuilt watchlist is smaller
 *
 * That is exactly right for the TA sync, whose job is never to lose a symbol
 * from a 314-entry list the user curates by hand. It is exactly wrong here,
 * where the list is regenerated every morning and shrinking is the point.
 *
 * So the guard is INVERTED rather than removed. Instead of *never shrink*, it
 * is **never write to a list you do not own**:
 *
 *   - the target is resolved by EXACT name match, never by "active"
 *   - the id is re-confirmed against that name immediately before the write
 *   - a run that cannot find the list FAILS rather than falling back
 *
 * That last point is the one that matters. TradingView's "active" list is
 * whatever the user happened to click last — on this account that is the
 * 314-entry TA list — so a fallback to active would silently replace a curated
 * watchlist with twenty screen hits.
 *
 * Everything else is reused from the sync path: same endpoints, same session,
 * same post-write verification.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate } from '../connection.js';

const TV = 'https://www.tradingview.com';

/** Run a fetch inside the page, where the session cookie applies. */
async function pageFetch(expr) {
  const res = await evaluate(expr, { awaitPromise: true });
  if (res?.err) throw new Error(res.err);
  return res;
}

/** Every custom list, with id and name. */
export async function listAll() {
  const res = await pageFetch(`
    fetch("${TV}/api/v1/symbols_list/custom/", { credentials: "include" })
      .then(function(r){ return r.json(); })
      .then(function(j){ return (j||[]).map(function(x){ return { id:x.id, name:x.name, n:(x.symbols||[]).length, active:!!x.active }; }); })
      .catch(function(e){ return { err: String(e) }; })
  `);
  if (!Array.isArray(res)) throw new Error('Could not read the custom watchlists.');
  return res;
}

/**
 * Resolve a list by EXACT name.
 *
 * Case-sensitive and exact on purpose. A near-match is how you end up writing
 * twenty symbols over `TA_TradingView_Watchlist`.
 */
export async function findByName(name) {
  const all = await listAll();
  const hits = all.filter((l) => l.name === name);
  if (!hits.length) {
    throw new Error(`No watchlist named exactly "${name}". Found: ${all.map((l) => l.name).join(', ')}. `
      + 'Create it in TradingView first — this tool does not create lists.');
  }
  if (hits.length > 1) {
    throw new Error(`${hits.length} watchlists are named "${name}". Rename one — an ambiguous target is not safe to overwrite.`);
  }
  return hits[0];
}

/**
 * The symbols currently in the named list.
 *
 * The morning screen needs this BEFORE it rewrites: names dropping out of the
 * list keep their drawings otherwise, because the next run only visits names it
 * is about to draw on.
 */
export async function listContents(name) {
  const target = await findByName(name);
  const res = await pageFetch(`
    fetch("${TV}/api/v1/symbols_list/custom/", { credentials: "include" })
      .then(function(r){ return r.json(); })
      .then(function(j){ var l = (j||[]).filter(function(x){ return x.id === ${target.id}; })[0];
                         return l ? (l.symbols || []) : { err: "list vanished between reads" }; })
      .catch(function(e){ return { err: String(e) }; })
  `);
  if (!Array.isArray(res)) throw new Error('Could not read the list contents.');
  return res;
}

/**
 * Replace the contents of the named list.
 *
 * `symbols` are full TradingView symbols ("NASDAQ:AAPL"). Duplicates are
 * removed first: TradingView rejects the entire write with 422 if any symbol
 * repeats, which would fail the run over one repeat.
 */
export async function rewrite({ name, symbols, dry_run = true, backup_dir = 'backups' }) {
  if (!name) throw new Error('A list name is required.');
  const clean = [...new Set((symbols || []).filter(Boolean))];
  if (!clean.length) throw new Error('Refusing to write an empty list — that would erase it with nothing to show.');

  const target = await findByName(name);

  // Read the current contents so the write can be backed up and verified.
  const before = await pageFetch(`
    fetch("${TV}/api/v1/symbols_list/custom/", { credentials: "include" })
      .then(function(r){ return r.json(); })
      .then(function(j){ var l = (j||[]).filter(function(x){ return x.id === ${target.id}; })[0];
                         return l ? { id:l.id, name:l.name, symbols:l.symbols||[] } : { err: "list vanished between reads" }; })
      .catch(function(e){ return { err: String(e) }; })
  `);

  // RE-CONFIRM the id still belongs to that name, immediately before writing.
  if (before.name !== name) {
    throw new Error(`List ${target.id} is named "${before.name}", expected "${name}". Refusing to write.`);
  }

  if (dry_run) {
    return {
      success: true, dry_run: true, list: { id: target.id, name },
      would_write: clean.length, currently: before.symbols.length,
      removed: before.symbols.filter((s) => !clean.includes(s)).length,
      added: clean.filter((s) => !before.symbols.includes(s)).length,
      note: 'Nothing written. Pass dry_run: false to apply.',
    };
  }

  mkdirSync(backup_dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = join(backup_dir, `watchlist-${name.replace(/\W+/g, '_')}-${stamp}.json`);
  writeFileSync(backup, JSON.stringify({ id: target.id, name, symbols: before.symbols }, null, 2), 'utf8');

  /**
   * THREE ENDPOINTS, AND `/replace/` IS NOT THE ONE.
   *
   * Measured against the live API:
   *
   *   POST .../append/    200  adds symbols, returns the new list
   *   POST .../remove/    200  removes symbols, returns what is left
   *   POST .../replace/   422  "You can't add new symbols during safe replace
   *                            (reorder)" — and equally for removals
   *
   * `/replace/` is a REORDER. It rejects any write whose symbol SET differs
   * from the current one, in either direction. A full rewrite is therefore
   * remove-then-append, with `/replace/` used afterwards only to impose the
   * ranking order now that the set matches.
   *
   * (This is also why `applySync` in watchlist_sync.js no longer works: it
   * writes a superset through `/replace/`. Same 422.)
   */
  const call = async (path, symbols) => {
    if (!symbols.length) return { ok: true, skipped: true };
    const r = await pageFetch(`
      fetch("${TV}/api/v1/symbols_list/custom/${target.id}/${path}/", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: ${JSON.stringify(JSON.stringify(symbols))}
      })
        .then(function(r){ return r.text().then(function(t){ return { status:r.status, ok:r.ok, body:t.slice(0,200) }; }); })
        .catch(function(e){ return { err: String(e) }; })
    `);
    if (!r?.ok) throw new Error(`${path} rejected (HTTP ${r?.status}): ${r?.body}`);
    return r;
  };

  const toRemove = before.symbols.filter((s) => !clean.includes(s));
  const toAdd = clean.filter((s) => !before.symbols.includes(s));

  // Remove first. Appending first would briefly hold both lists at once, and a
  // failure between the two calls would leave a superset rather than a
  // half-written list — harder to notice and harder to undo.
  await call('remove', toRemove);
  await call('append', toAdd);
  // Now the set matches, so a reorder is legal and imposes the ranking.
  const res = await call('replace', clean);
  if (res?.skipped) { /* nothing to order */ }

  // Verify by reading back, not by trusting the 200.
  const after = await pageFetch(`
    fetch("${TV}/api/v1/symbols_list/custom/", { credentials: "include" })
      .then(function(r){ return r.json(); })
      .then(function(j){ var l = (j||[]).filter(function(x){ return x.id === ${target.id}; })[0];
                         return l ? { name:l.name, n:(l.symbols||[]).length } : { err:"gone" }; })
      .catch(function(e){ return { err: String(e) }; })
  `);
  if (after.n !== clean.length) {
    throw new Error(`Wrote ${clean.length} symbols but the list now holds ${after.n}. `
      + `Previous contents are backed up at ${backup}.`);
  }

  return {
    success: true, applied: true, verified: true,
    list: { id: target.id, name },
    entries_before: before.symbols.length,
    entries_after: after.n,
    backup,
    note: 'Full replace. Only the list matching this exact name was touched.',
  };
}
